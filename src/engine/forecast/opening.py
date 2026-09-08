"""F6 — THE OPENING POSITION IS THE SOURCE PERIOD'S CLOSING BALANCES.

To the cent, from the CANONICAL balance sheet, read through the ONE
sanctioned reader (``engine.serving.facts.FactsGateway``) — never the
legacy ``statements.assembled_bs`` assembly, and never by re-deriving
totals from account-code prefixes.

WHY THAT SENTENCE IS LOAD-BEARING
=================================
The two assemblies disagree. Measured on the committed agras book:

    canonical_bs.totals.assets   39,319,114.09
    assembled_bs.total_assets    39,272,501.03

a gap of 46,613.06 — the unclassified account-413 balance, which the
canonical statement carries as a row (``unclassified_debit``) and the
legacy assembly drops. A projection opened on the legacy figure starts
46,613.06 short of the balance sheet the same product prints on the
page before it, and every projected year inherits the discrepancy. So
this module reads canonical, and PROVES it did: the partition below is
checked against the gateway's own totals and refuses if it lost a cent.

NOTHING IS DROPPED
==================
Every served row lands in exactly one forecast line. Rows the canonical
schema knows are routed by their ``parent_aggregate``; rows it does not
(``unclassified_debit``, the synthetic ``reconciliation_adjustment``)
fall to the residual line of their SECTION — which is why the partition
can be proven complete rather than assumed complete. A row in a section
this module does not recognise is a REFUSAL, not a guess.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from engine.canonical.schema_v1 import PARENT_AGGREGATES_BS, bucket_by_name

from .errors import OpeningPositionError
from .money import fmt

__all__ = [
    "ASSET_LINES",
    "EL_LINES",
    "LINES",
    "OpeningPosition",
    "OpeningLine",
]

#: Asset-side forecast lines, in statement order.
ASSET_LINES = (
    "cash",
    "ar",
    "inventory",
    "other_current_assets",
    "ppe_net",
    "intangibles_net",
    "investment_property",
    "other_non_current_assets",
)

#: Equity-and-liabilities forecast lines, in statement order. ``revolver``
#: always opens at zero: a trial balance has no "revolver" — any drawn
#: overdraft is already inside ``st_debt`` — so the funding line starts
#: empty and only exists once the projection draws it (F8).
EL_LINES = (
    "ap",
    "other_current_liabilities",
    "st_debt",
    "revolver",
    "lt_debt",
    "other_non_current_liabilities",
    "equity_contributed",
    "equity_reserves",
    "equity_retained",
    "equity_other",
)

LINES = ASSET_LINES + EL_LINES

#: Lines that are current for the purpose of the projected current
#: ratio and working capital.
CURRENT_ASSET_LINES = ("cash", "ar", "inventory", "other_current_assets")
CURRENT_LIABILITY_LINES = ("ap", "other_current_liabilities", "st_debt",
                           "revolver")
EQUITY_LINES = ("equity_contributed", "equity_reserves", "equity_retained",
                "equity_other")

#: Canonical parent aggregate -> forecast line. Every aggregate the
#: canonical BS schema defines appears here; a new aggregate that nobody
#: maps fails at import (see the coverage assertion at the bottom)
#: rather than silently landing in a residual and moving a total.
_AGGREGATE_TO_LINE = {
    # assets
    "cash_and_equivalents": "cash",
    "trade_receivables_net": "ar",
    "other_receivables": "other_current_assets",
    "inventory_net": "inventory",
    "prepaid_expenses_and_other": "other_current_assets",
    "ppe_net": "ppe_net",
    "investment_property": "investment_property",
    "right_of_use_assets": "other_non_current_assets",
    "intangibles_net": "intangibles_net",
    "financial_investments": "other_non_current_assets",
    "deferred_tax_assets": "other_non_current_assets",
    "other_non_current_assets": "other_non_current_assets",
    # liabilities
    "trade_payables": "ap",
    "tax_payables": "other_current_liabilities",
    "personnel_payables": "other_current_liabilities",
    "other_payables_st": "other_current_liabilities",
    "deferred_revenue_st": "other_current_liabilities",
    "provisions_st": "other_current_liabilities",
    "financial_liabilities_st": "st_debt",
    "financial_liabilities_lt": "lt_debt",
    "deferred_tax_liabilities": "other_non_current_liabilities",
    "provisions_lt": "other_non_current_liabilities",
    "pension_liabilities": "other_non_current_liabilities",
    "deferred_income_lt": "other_non_current_liabilities",
    "other_non_current_liabilities": "other_non_current_liabilities",
    # equity
    "contributed_capital": "equity_contributed",
    "reserves": "equity_reserves",
    "retained_earnings": "equity_retained",
    "treasury_shares": "equity_other",
    "accumulated_oci": "equity_other",
    "non_controlling_interest": "equity_other",
    "convertible_debt_equity_component": "equity_other",
}

#: Row-level overrides, applied BEFORE the aggregate table.
#: ``cash_and_equivalents`` is the only aggregate whose leaves do not all
#: behave alike for a forecast: restricted cash cannot absorb a funding
#: gap and short-term investments are not the balancing item, so neither
#: joins the plug. They are held at their opening balance instead.
_ROW_TO_LINE = {
    "cash_restricted": "other_current_assets",
    "short_term_investments": "other_current_assets",
}

#: Section -> the line an UNKNOWN row of that section falls to. This is
#: what keeps the partition total-preserving for rows the canonical
#: schema does not name (``unclassified_debit`` / ``unclassified_credit``
#: from the RO adapter, ``reconciliation_adjustment`` from the serve
#: path). An unlisted section is refused, never guessed.
_SECTION_RESIDUAL = {
    "non_current_assets": "other_non_current_assets",
    "current_assets": "other_current_assets",
    "prepaid_expenses": "other_current_assets",
    "equity": "equity_other",
    "provisions": "other_non_current_liabilities",
    "non_current_liabilities": "other_non_current_liabilities",
    "current_liabilities": "other_current_liabilities",
    "deferred_income": "other_non_current_liabilities",
}

_ASSET_SECTIONS = ("non_current_assets", "current_assets", "prepaid_expenses")


def _side_of_line(line: str) -> str:
    return "assets" if line in ASSET_LINES else "equity_plus_liabilities"


class OpeningLine(object):
    """One forecast line at the opening date, and the canonical rows
    behind it — so any opening figure can be traced back to the served
    statement row and, through it, to the ledger accounts."""

    __slots__ = ("line", "amount_cents", "rows")

    def __init__(self, line: str, amount_cents: int,
                 rows: Tuple[Tuple[str, int], ...]) -> None:
        self.line = line
        self.amount_cents = int(amount_cents)
        self.rows = rows

    def as_dict(self) -> Dict[str, Any]:
        from .money import to_float
        return {
            "line": self.line,
            "amount": to_float(self.amount_cents),
            "rows": [{"id": rid, "amount": to_float(cents)}
                     for rid, cents in self.rows],
        }


class OpeningPosition(object):
    """The projection's period zero. Immutable once built."""

    __slots__ = ("lines", "_by_line", "currency", "period_end",
                 "snapshot_id", "totals")

    def __init__(self, lines: Tuple[OpeningLine, ...], currency: str,
                 period_end: str, snapshot_id: Optional[str],
                 totals: Dict[str, int]) -> None:
        self.lines = lines
        self._by_line = dict((ln.line, ln.amount_cents) for ln in lines)
        self.currency = currency
        self.period_end = period_end
        self.snapshot_id = snapshot_id
        self.totals = totals

    def cents(self, line: str) -> int:
        if line not in self._by_line:
            raise KeyError("no opening line %r" % (line,))
        return self._by_line[line]

    def balances(self) -> Dict[str, int]:
        """A fresh mutable copy — the projector's period-zero state."""
        return dict(self._by_line)

    def total_assets_cents(self) -> int:
        return sum(self._by_line[l] for l in ASSET_LINES)

    def total_el_cents(self) -> int:
        return sum(self._by_line[l] for l in EL_LINES)

    def as_dict(self) -> Dict[str, Any]:
        from .money import to_float
        return {
            "period_end": self.period_end,
            "currency": self.currency,
            "snapshot_id": self.snapshot_id,
            "lines": [ln.as_dict() for ln in self.lines],
            "served_totals": dict((k, to_float(v))
                                  for k, v in sorted(self.totals.items())),
        }

    # ── construction ──────────────────────────────────────────────────

    @classmethod
    def from_gateway(cls, gateway: Any, period_end: str) -> "OpeningPosition":
        """Partition the SERVED canonical balance sheet into forecast
        lines and prove nothing was lost.

        Raises :class:`OpeningPositionError` when the serving carries no
        canonical balance sheet, when a row sits in a section this
        module does not recognise, when a known row's section disagrees
        with its canonical side, or when the partition does not
        reproduce the gateway's own totals to the cent.
        """
        served = getattr(gateway, "served_canonical_bs", None)
        if not isinstance(served, dict):
            raise OpeningPositionError(
                "a forecast needs a canonical balance sheet to open on; this "
                "serving is tier=%r and carries none"
                % (getattr(gateway, "tier", None),)
            )
        buckets = dict((line, 0) for line in LINES)
        rows_by_line = dict((line, []) for line in LINES)  # type: Dict[str, List[Tuple[str, int]]]
        for raw in (served.get("rows") or []):
            if not isinstance(raw, dict):
                continue
            row_id = str(raw.get("id") or "")
            section = str(raw.get("section") or "")
            if not row_id:
                raise OpeningPositionError(
                    "the served balance sheet carries a row with no id "
                    "(section %r) — it cannot be placed" % (section,)
                )
            if section not in _SECTION_RESIDUAL:
                raise OpeningPositionError(
                    "served balance-sheet row %r sits in section %r, which "
                    "this forecast does not know how to place. Refusing "
                    "rather than guessing a side." % (row_id, section)
                )
            # The gateway is the authority for the AMOUNT (it is the one
            # reader that applies the serve-path reconciliation), so the
            # cents come from statement_line(), not from the raw row.
            amount_cents = gateway.statement_line(row_id).amount_minor
            line = _ROW_TO_LINE.get(row_id)
            if line is None:
                bucket = bucket_by_name(row_id)
                if bucket is not None:
                    line = _AGGREGATE_TO_LINE.get(bucket.parent_aggregate)
            if line is None:
                line = _SECTION_RESIDUAL[section]
            expected_side = ("assets" if section in _ASSET_SECTIONS
                             else "equity_plus_liabilities")
            if _side_of_line(line) != expected_side:
                raise OpeningPositionError(
                    "served row %r is in section %r (%s side) but the "
                    "canonical schema places it on forecast line %r (%s "
                    "side). The two authorities disagree; refusing to pick "
                    "one." % (row_id, section, expected_side, line,
                              _side_of_line(line)),
                    side=expected_side,
                )
            buckets[line] += amount_cents
            rows_by_line[line].append((row_id, amount_cents))

        lines = tuple(
            OpeningLine(line, buckets[line], tuple(rows_by_line[line]))
            for line in LINES
        )
        position = cls(
            lines=lines,
            currency=str(getattr(gateway, "_currency", "") or "RON"),
            period_end=period_end,
            snapshot_id=_snapshot_id_of(gateway),
            totals=_served_totals(gateway),
        )
        _assert_partition_reproduces_serving(position, gateway)
        return position


def _snapshot_id_of(gateway: Any) -> Optional[str]:
    try:
        provenance = gateway.total_assets().provenance
    except Exception:  # pragma: no cover - gateway always answers here
        return None
    value = provenance.get("snapshot_id") if isinstance(provenance, dict) else None
    return str(value) if value else None


def _served_totals(gateway: Any) -> Dict[str, int]:
    return {
        "assets": gateway.total_assets().amount_minor,
        "equity": gateway.equity().amount_minor,
        "liabilities": gateway.total_liabilities().amount_minor,
        "equity_plus_liabilities": gateway.equity_plus_liabilities().amount_minor,
        "current_assets": gateway.current_assets().amount_minor,
        "current_liabilities": gateway.current_liabilities().amount_minor,
    }


def _assert_partition_reproduces_serving(position: "OpeningPosition",
                                         gateway: Any) -> None:
    """F6, proven rather than asserted in prose: the forecast lines must
    add back to the SERVED totals, to the cent, on both sides."""
    checks = (
        ("assets", position.total_assets_cents(),
         gateway.total_assets().amount_minor),
        ("equity_plus_liabilities", position.total_el_cents(),
         gateway.equity_plus_liabilities().amount_minor),
    )
    for side, partitioned, served in checks:
        if partitioned != served:
            raise OpeningPositionError(
                "the opening partition lost %s on the %s side: forecast "
                "lines total %s, the served canonical balance sheet says "
                "%s. Every served row must land in exactly one forecast "
                "line." % (fmt(partitioned - served), side,
                           fmt(partitioned), fmt(served)),
                side=side,
                delta_cents=partitioned - served,
            )


def _assert_every_aggregate_is_mapped() -> None:
    """Import-time coverage: a canonical BS aggregate nobody routes would
    otherwise fall to a section residual and quietly move a total."""
    missing = sorted(set(PARENT_AGGREGATES_BS) - set(_AGGREGATE_TO_LINE))
    if missing:
        raise ImportError(
            "engine.forecast.opening does not route these canonical "
            "balance-sheet aggregates: %s" % ", ".join(missing)
        )
    unknown = sorted(set(_AGGREGATE_TO_LINE) - set(PARENT_AGGREGATES_BS))
    if unknown:
        raise ImportError(
            "engine.forecast.opening routes aggregates the canonical "
            "schema does not define: %s" % ", ".join(unknown)
        )
    bad = sorted(l for l in _AGGREGATE_TO_LINE.values() if l not in LINES)
    if bad:
        raise ImportError("unknown forecast lines in the aggregate map: %s"
                          % ", ".join(bad))
    bad_rows = sorted(l for l in _ROW_TO_LINE.values() if l not in LINES)
    if bad_rows:
        raise ImportError("unknown forecast lines in the row map: %s"
                          % ", ".join(bad_rows))
    bad_res = sorted(l for l in _SECTION_RESIDUAL.values() if l not in LINES)
    if bad_res:
        raise ImportError("unknown forecast lines in the section residual "
                          "map: %s" % ", ".join(bad_res))


_assert_every_aggregate_is_mapped()
