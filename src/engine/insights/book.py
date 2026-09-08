"""A READ-ONLY view of one finished book, for the insight detectors.

THE ONE RULE THIS FILE EXISTS TO ENFORCE
========================================
A detector may not reach into the served payload and pick a number out of
it. It asks this object, and this object answers from ONE authority per
kind of fact:

  balance-sheet figures   `envelope.canonical_bs.rows` — the canonical
                          rows, each carrying its own `leaf_ids`, which
                          ARE the RO account codes. A figure and the
                          accounts behind it therefore come from the same
                          place and cannot disagree.
  P&L figures             `statements.assembled_pl` — the assembled P&L.
  account balances        `line_items`, addressed BY CODE.

Why not derive the balance-sheet figures from account-code prefixes:
measured on the four committed books, a prefix table agrees with the
engine's own classification for PP&E and intangibles and DISAGREES for
every receivable family — the engine classifies on more than the prefix
(sign, sub-account, pack rule). A detector re-deriving from prefixes
would print a related-party exposure of 7,536,754.90 where the engine's
own statements say 7,692,202.74. One concept, one value: the canonical
rows win, and the account codes come from the same rows.

ABSENT != ZERO
==============
`row_sum` over rows that are all missing returns None, not 0.0. A book
with no PP&E and a book whose PP&E the payload failed to carry are
different facts and this object refuses to conflate them. Every caller
must handle None; `Book.money`/`Book.basis` never invent a figure.

No I/O. No network. No DB. Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = ["Book", "AccountRef", "RowRef"]


class AccountRef(object):
    """One ledger account as the book carries it: code, name, balance."""

    __slots__ = ("code", "name", "amount", "role")

    def __init__(self, code: str, name: str, amount: float, role: str) -> None:
        self.code = code
        self.name = name
        self.amount = amount
        self.role = role

    def as_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "name": self.name,
            "amount": round(float(self.amount), 2),
            "role": self.role,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "AccountRef(%s, %.2f, %s)" % (self.code, self.amount, self.role)


class RowRef(object):
    """One canonical balance-sheet row: id, label, amount, account codes."""

    __slots__ = ("row_id", "label", "amount", "section", "leaf_ids")

    def __init__(self, row_id: str, label: str, amount: float, section: str,
                 leaf_ids: Sequence[str]) -> None:
        self.row_id = row_id
        self.label = label
        self.amount = amount
        self.section = section
        self.leaf_ids = tuple(leaf_ids)


def _num(value: Any) -> Optional[float]:
    """A float, or None. Strings, bools and NaN are ABSENT, not zero."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if out != out:  # NaN
        return None
    return out


class Book(object):
    """Everything a detector is allowed to read, and nothing else."""

    def __init__(self, payload: Dict[str, Any]) -> None:
        payload = payload if isinstance(payload, dict) else {}
        statements = payload.get("statements")
        if not isinstance(statements, dict):
            statements = payload if "assembled_pl" in payload else {}
        self._statements = statements
        self._pl = statements.get("assembled_pl") or {}
        self._bs = statements.get("assembled_bs") or {}
        envelope = payload.get("envelope")
        self._envelope = envelope if isinstance(envelope, dict) else {}
        canonical = self._envelope.get("canonical_bs")
        self._canonical = canonical if isinstance(canonical, dict) else {}
        self._line_items = [
            li for li in (payload.get("line_items") or []) if isinstance(li, dict)
        ]

        self.currency = str(
            statements.get("currency") or payload.get("currency") or "RON"
        )
        self.company_name = str(statements.get("companyName") or "")
        self.period_label = str(statements.get("periodLabel") or "")

        self._rows = {}  # type: Dict[str, RowRef]
        for raw in (self._canonical.get("rows") or []):
            if not isinstance(raw, dict):
                continue
            amount = _num(raw.get("amount"))
            if amount is None:
                continue
            row_id = str(raw.get("id") or "")
            if not row_id:
                continue
            self._rows[row_id] = RowRef(
                row_id,
                str(raw.get("label") or row_id),
                amount,
                str(raw.get("section") or ""),
                [str(x) for x in (raw.get("leaf_ids") or [])],
            )

        self._by_code = {}  # type: Dict[str, Dict[str, Any]]
        for li in self._line_items:
            code = str(li.get("ro_account_code") or "")
            if code:
                self._by_code[code] = li

    # ── raw reads ──────────────────────────────────────────────────────

    def pl(self, key: str) -> Optional[float]:
        """One assembled-P&L figure, or None when the payload omits it."""
        return _num(self._pl.get(key))

    #: The canonical balance sheet names its totals differently from the
    #: legacy assembly. Mapping the ones detectors actually ask for.
    _CANONICAL_TOTALS = {
        "total_assets": "assets",
        "total_equity": "equity",
        "total_liabilities": "liabilities",
        "total_current_assets": "current_assets",
        "total_current_liabilities": "current_liabilities",
    }

    def bs(self, key: str) -> Optional[float]:
        """One balance-sheet total, CANONICAL FIRST.

        This module's own docstring says balance-sheet figures come from
        ``envelope.canonical_bs`` — "a figure and the accounts behind it
        therefore come from the same place and cannot disagree" — and this
        method read ``statements.assembled_bs`` instead, which is the
        legacy assembly. The two differ by whatever the canonical BS
        carries and the legacy path drops.

        Measured on the agras book, and printed in the delivered PDF:

            canonical_bs.totals.assets   39,319,114.09   (statement, p7)
            assembled_bs.total_assets    39,272,501.03   (finding,   p24)

        ...a gap of 46,613.06, which is exactly the unclassified
        account-413 balance THE FINDING ON PAGE 24 IS ABOUT. So the
        detector graded that balance as a share of a balance sheet that
        excludes it, and printed that base beside a statement saying
        something else, on the same document.

        Falls back to the legacy assembly for any key the canonical totals
        do not carry, so a detector asking for something outside the five
        mapped totals keeps working rather than silently reading None.
        """
        canonical_key = self._CANONICAL_TOTALS.get(key)
        if canonical_key is not None:
            totals = self._canonical.get("totals")
            if isinstance(totals, dict):
                v = _num(totals.get(canonical_key))
                if v is not None:
                    return v
        return _num(self._bs.get(key))

    def has_row(self, row_id: str) -> bool:
        return row_id in self._rows

    def row(self, row_id: str) -> Optional[RowRef]:
        return self._rows.get(row_id)

    def row_ids(self) -> Tuple[str, ...]:
        return tuple(sorted(self._rows))

    def diagnoses(self) -> Tuple[Dict[str, Any], ...]:
        out = []  # type: List[Dict[str, Any]]
        for d in (self._canonical.get("diagnosis") or []):
            if isinstance(d, dict):
                out.append(d)
        return tuple(out)

    def unmapped(self) -> Tuple[Dict[str, Any], ...]:
        out = []  # type: List[Dict[str, Any]]
        for d in (self._canonical.get("unmapped") or []):
            if isinstance(d, dict):
                out.append(d)
        return tuple(out)

    # ── derived reads, all ABSENT-safe ─────────────────────────────────

    def row_sum(self, row_ids: Iterable[str]) -> Optional[float]:
        """Sum of the canonical rows that EXIST. None when none of them do
        — a book that never carried the rows is not a book whose rows are
        zero."""
        total = 0.0
        seen = False
        for row_id in row_ids:
            ref = self._rows.get(row_id)
            if ref is None:
                continue
            seen = True
            total += ref.amount
        return total if seen else None

    def accounts_for(self, row_ids: Iterable[str], role: str) -> List[AccountRef]:
        """Every ledger account behind those canonical rows, in the order
        the rows declare, with the balance the book carries for it."""
        out = []  # type: List[AccountRef]
        for row_id in row_ids:
            ref = self._rows.get(row_id)
            if ref is None:
                continue
            for code in ref.leaf_ids:
                li = self._by_code.get(code)
                if li is not None:
                    amount = _num(li.get("amount"))
                    name = str(li.get("ro_account_name") or "")
                elif len(ref.leaf_ids) == 1:
                    # A canonical row can name an account the served
                    # line_items do not carry — account 121 is EXCLUDED
                    # from them as the profit control account
                    # (`canonical_bs.excluded`), and the reconstruction-gap
                    # finding is precisely about 121. When the row names
                    # exactly one account, the ROW's amount IS that
                    # account's balance, so the evidence can still name it.
                    amount = ref.amount
                    name = ref.label
                else:
                    # More than one account behind the row and no line
                    # item for this one: the balance cannot be attributed.
                    # Withhold it rather than printing a zero or guessing
                    # a split.
                    amount = None
                    name = ""
                if amount is None:
                    continue
                out.append(AccountRef(code, name, amount, role))
        return out

    # ── the severity bases, named once ─────────────────────────────────

    #: Every basis a detector may scale against, and where it comes from.
    #: A basis absent here is a pack error, not a silent zero.
    BASES = (
        "revenue",
        "total_assets",
        "total_equity",
        "total_current_liabilities",
        "ebitda",
        "ebitda_positive",
        "gross_ppe",
        "reconstructed_net_income",
    )

    def basis(self, name: str) -> Optional[float]:
        """The scale a severity is graded against. None == unavailable,
        and a detector whose basis is None grades `info` and says why."""
        if name == "revenue":
            return _positive(self.pl("revenue"))
        if name == "total_assets":
            return _positive(self.bs("total_assets"))
        if name == "total_equity":
            return _positive(self.bs("total_equity"))
        if name == "total_current_liabilities":
            return _positive(self.bs("total_current_liabilities"))
        if name == "ebitda":
            value = self.pl("ebitda")
            return None if value is None else abs(value)
        if name == "ebitda_positive":
            return _positive(self.pl("ebitda"))
        if name == "gross_ppe":
            return _positive(self.row_sum(_GROSS_PPE_ROWS))
        if name == "reconstructed_net_income":
            value = self.pl("net_income_operational")
            if value is None:
                return None
            return abs(value) if abs(value) > 0.005 else None
        return None


def _positive(value: Optional[float]) -> Optional[float]:
    """A basis has to be a positive scale. Zero and negative are not
    "small" — they are unusable, and saying so is the honest answer."""
    if value is None:
        return None
    return value if value > 0.0 else None


#: Named once, quoted by `Book.basis` and by the asset-age detector's pack
#: entry, so the two cannot drift.
_GROSS_PPE_ROWS = (
    "ppe_land",
    "ppe_buildings",
    "ppe_machinery_equipment",
    "ppe_furniture_office",
    "ppe_under_construction",
    "ppe_advances",
    "ppe_investment_property",
)
