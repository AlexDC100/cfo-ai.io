"""A READ-ONLY view of one actuals period, for driver derivation.

WHY THIS WRAPS `engine.insights.book.Book` INSTEAD OF RE-READING THE
PAYLOAD
===================================================================
`Book` already settled the hardest question in this codebase: which of
the two balance sheets in a served payload is the authority. Its own
docstring records the cost of getting it wrong — the delivered agras PDF
printed `canonical_bs.totals.assets 39,319,114.09` on page 7 and
`assembled_bs.total_assets 39,272,501.03` on page 24, a 46,613.06 gap
that is exactly the unclassified account-413 balance. A forecast that
re-derived its own balance-sheet reads would be the fourth surface with
its own opinion. It composes `Book` instead, so a forecast and a finding
cannot disagree about the company they describe.

WHAT THIS ADDS ON TOP OF `Book`
===============================
Three payload regions `Book` has no reason to expose, and which drivers
need:

  `envelope.methodology.ratios`   THE published DSO / DIO / DPO / gross
        margin. Read, never recomputed. There are already two gross
        profits in a served payload (`assembled_pl.gross_profit` and
        `methodology.totals.gross_profit`, 48,019,704.96 and
        46,989,940.34 on the agras book); computing a third from
        whichever one happened to be nearer would put two gross margins
        on one document.
  `statements.assembled_bands`    the STRONG / HEALTHY / WATCH rungs the
        report's own verdict grades this company on. The upside and
        downside cases land on those rungs, so a case bound is never a
        number this lane chose.
  `envelope.leaves` / `.aggregates`  the expense-nature detail behind the
        fixed/variable split and personnel cost.
  `envelope.canonical_bs.invariants.p121_cross_check.p121`  the closing
        balance of account 121 — the profit the company FILED. The P&L
        does not carry it: `assembled_pl.net_income_statutory` is the
        filed figure only when the assembly's anchor override fired, and
        the reconstruction otherwise. See `filed_net_income_121`.

WHAT THIS DELIBERATELY REFUSES TO READ
======================================
`statements.assembled_cf`. Every figure in it is produced by a path that
stamps `is_approximated: true` and writes its own note — on the agras
book, "Working-capital movements estimated at 5% of current balances" and
"Financing detail ... approximated from typical Romanian payout ratios".
`capex_total` and `dividends_paid` come from there. Defaulting a capex
plan or a payout ratio from them would launder an approximation into a
"derived" default, which is the precise confusion this lane exists to
prevent. Both drivers are instead absent or explicitly a fallback.

ABSENT != ZERO throughout: every accessor returns `Optional[float]` and
none of them invents a figure.

No I/O. No network. No clocks. Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ..insights.book import Book

__all__ = ["ActualsPeriod", "Band"]


def _num(value):
    # type: (Any) -> Optional[float]
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


class Band(object):
    """One verdict band as the served payload carries it.

    `strong` / `healthy` / `watch` are the rungs; `direction` says which
    way is better. These are the report's OWN thresholds — the same ones
    the verdict beside the ratio is graded on.
    """

    __slots__ = ("key", "strong", "healthy", "watch", "direction")

    def __init__(self, key, strong, healthy, watch, direction):
        # type: (str, Optional[float], Optional[float], Optional[float], str) -> None
        self.key = str(key)
        self.strong = strong
        self.healthy = healthy
        self.watch = watch
        self.direction = str(direction)

    @property
    def higher_is_better(self):
        # type: () -> bool
        return self.direction == "higher"

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {"key": self.key, "strong": self.strong,
                "healthy": self.healthy, "watch": self.watch,
                "direction": self.direction}


class ActualsPeriod(object):
    """One finished period of actuals, addressed by the facts a driver
    needs."""

    def __init__(self, payload):
        # type: (Dict[str, Any]) -> None
        payload = payload if isinstance(payload, dict) else {}
        self._payload = payload
        self.book = Book(payload)

        statements = payload.get("statements")
        self._statements = statements if isinstance(statements, dict) else {}
        envelope = payload.get("envelope")
        self._envelope = envelope if isinstance(envelope, dict) else {}

        methodology = self._envelope.get("methodology")
        self._methodology = methodology if isinstance(methodology, dict) else {}
        ratios = self._methodology.get("ratios")
        self._ratios = ratios if isinstance(ratios, dict) else {}

        bands = self._statements.get("assembled_bands")
        bands = bands if isinstance(bands, dict) else {}
        self._bands_disclosure = str(bands.get("disclosure") or "")
        self._bands_source = str(bands.get("source") or "")
        raw_bands = bands.get("bands")
        self._bands = raw_bands if isinstance(raw_bands, dict) else {}

        leaves = self._envelope.get("leaves")
        self._leaves = leaves if isinstance(leaves, dict) else {}
        aggregates = self._envelope.get("aggregates")
        self._aggregates = aggregates if isinstance(aggregates, dict) else {}

        provenance = self._envelope.get("provenance")
        self._provenance = provenance if isinstance(provenance, dict) else {}

        canonical_bs = self._envelope.get("canonical_bs")
        canonical_bs = canonical_bs if isinstance(canonical_bs, dict) else {}
        invariants = canonical_bs.get("invariants")
        invariants = invariants if isinstance(invariants, dict) else {}
        p121 = invariants.get("p121_cross_check")
        self._p121_block = p121 if isinstance(p121, dict) else {}

        self.period_end = str(payload.get("period_end") or "")
        self.period_start = str(payload.get("period_start") or "")
        self.period_label = str(self._statements.get("periodLabel") or "")
        self.currency = str(
            self._statements.get("currency") or payload.get("currency") or "RON"
        )
        supplementary = self._statements.get("supplementary")
        supplementary = supplementary if isinstance(supplementary, dict) else {}
        self.period_days = _num(supplementary.get("periodDays"))

    # ── identity, for provenance ───────────────────────────────────────

    def provenance(self):
        # type: () -> Dict[str, Any]
        """Where these actuals came from. A saved forecast records this so
        it can always be traced back to the uploaded file it started
        from."""
        return {
            "period_end": self.period_end,
            "period_start": self.period_start,
            "period_label": self.period_label,
            "currency": self.currency,
            "period_days": self.period_days,
            "source_document_id": self._provenance.get("source_document_id"),
            "content_hash": self._provenance.get("content_hash"),
            "original_filename": self._provenance.get("original_filename"),
        }

    # ── P&L, through Book ──────────────────────────────────────────────

    def pl(self, key):
        # type: (str) -> Optional[float]
        return self.book.pl(key)

    # ── the FILED result — the one figure the P&L does not carry ───────

    def filed_net_income_121(self):
        # type: () -> Optional[float]
        """The closing balance of account 121, as the engine published it.

        WHY THIS IS NOT READ FROM ``assembled_pl``. The P&L carries
        ``net_income_statutory``, and a reader would reasonably take that
        for the filed figure. It is not. The Romanian assembly replaces
        the reconstruction with the filed figure only when the two differ by
        more than ``max(|account 121|, 100_000) * 0.05``
        (``country_packs/ro_romania/chart_of_accounts.py``); below that
        band ``net_income_statutory`` stays the RECONSTRUCTION and the
        companion field ``net_income_unexplained_vs_121`` is set to
        ``0.0`` without anything having been measured. Measured on a real
        assembly run: a book that filed 20,000.00 against a
        reconstruction of 24,500.00 — a 4,500.00 miss — publishes
        ``net_income_unexplained_vs_121 = 0.00``, and so does a book that
        carries no account 121 at all.

        ``canonical_bs.invariants.p121_cross_check.p121`` is the account's
        own closing balance, captured before that comparison and
        published whether or not it fired. It is ``None`` when no
        account-121 row survived extraction — an ABSENCE, which is not a
        book whose build-up ties.
        """
        return _num(self._p121_block.get("p121"))

    # ── balance sheet, canonical-first, through Book ───────────────────

    def bs_total(self, key):
        # type: (str) -> Optional[float]
        return self.book.bs(key)

    def rows_sum(self, row_ids):
        # type: (Iterable[str]) -> Optional[float]
        """Sum of the canonical rows that EXIST. None when none do."""
        return self.book.row_sum(row_ids)

    def row(self, row_id):
        # type: (str) -> Optional[float]
        ref = self.book.row(row_id)
        return None if ref is None else ref.amount

    # ── the published ratios — THE authority for DSO/DIO/DPO/margin ────

    def ratio(self, key):
        # type: (str) -> Optional[float]
        entry = self._ratios.get(key)
        if not isinstance(entry, dict):
            return None
        return _num(entry.get("value"))

    def ratio_note(self, key):
        # type: (str) -> str
        """The engine's OWN caveat on a ratio, carried onto the driver
        rather than dropped. `capex_intensity` says in this field that it
        is a D&A proxy; a driver built on it must repeat that."""
        entry = self._ratios.get(key)
        if not isinstance(entry, dict):
            return ""
        return str(entry.get("note") or "").strip()

    # ── the verdict bands the cases are built from ─────────────────────

    def band(self, key):
        # type: (str) -> Optional[Band]
        entry = self._bands.get(key)
        if not isinstance(entry, dict):
            return None
        direction = str(entry.get("direction") or "")
        if direction not in ("higher", "lower"):
            return None
        return Band(key, _num(entry.get("strong")), _num(entry.get("healthy")),
                    _num(entry.get("watch")), direction)

    @property
    def bands_disclosure(self):
        # type: () -> str
        return self._bands_disclosure

    @property
    def bands_source(self):
        # type: () -> str
        return self._bands_source

    # ── leaves and aggregates ──────────────────────────────────────────

    def leaf(self, key):
        # type: (str) -> Optional[float]
        entry = self._leaves.get(key)
        if not isinstance(entry, dict):
            return None
        return _num(entry.get("ras_line_items_sum_signed"))

    def leaves_sum(self, keys):
        # type: (Iterable[str]) -> Tuple[Optional[float], Tuple[str, ...]]
        """Sum of the leaves that EXIST, and the names of the ones that
        did. Returns (None, ()) when none of them do — a book with no
        rent line is not a book whose rent is zero, and the caller needs
        to know WHICH leaves it actually got so the basis can name them.
        """
        total = 0.0
        found = []  # type: List[str]
        for key in keys:
            value = self.leaf(key)
            if value is None:
                continue
            found.append(key)
            total += value
        if not found:
            return None, ()
        return total, tuple(found)

    def aggregate(self, key):
        # type: (str) -> Optional[float]
        entry = self._aggregates.get(key)
        if not isinstance(entry, dict):
            return None
        return _num(entry.get("net"))

    # ── ledger evidence, addressed by account-code prefix ──────────────

    def accounts_with_prefix(self, prefixes):
        # type: (Sequence[str]) -> Tuple[Tuple[str, float], ...]
        """Served line items whose RO account code starts with any prefix.

        Used ONLY where a driver needs evidence that a thing HAPPENED —
        a declared dividend is a 457 or 129 balance and nothing else. Not
        used for any figure the canonical rows already carry: `Book`'s
        docstring measures what prefix-derivation costs, a related-party
        exposure of 7,536,754.90 against the engine's own 7,692,202.74.
        """
        out = []  # type: List[Tuple[str, float]]
        for li in (self._payload.get("line_items") or []):
            if not isinstance(li, dict):
                continue
            code = str(li.get("ro_account_code") or "")
            if not code:
                continue
            for prefix in prefixes:
                if code.startswith(prefix):
                    amount = _num(li.get("amount"))
                    if amount is not None:
                        out.append((code, amount))
                    break
        out.sort()  # deterministic: sorted by code, never payload order
        return tuple(out)
