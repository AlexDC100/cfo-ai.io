"""FACTS GATEWAY — the ONE typed reader of served balance-sheet truth.

Contract: docs/CANONICAL_BS_V2_CONTRACT.md (+ the auto-reconcile
addendum) and docs/served_envelope.schema.json (the sv1 served-envelope
schema this gateway is versioned against).

A ``FactsGateway`` is constructed from ONE persisted canonical envelope
(``financial_periods.assembled_canonical_v1``) and answers every
totals-level question about the SERVED statement — the post-serve
object: ``canonical_bs`` after ``engine.api._reconcile
.served_canonical_bs`` has applied any stored, validator-accepted
reconciliation. Every accessor returns a :class:`Fact` carrying the
amount in INTEGER MINOR UNITS (cents — no floats inside the gateway),
the currency, and provenance ``{snapshot_id, line_id}``.

Adjusted-by-placement, encapsulated HERE and nowhere else:
  · ``balance_sheet``-placed reconciliation → the synthetic "Diferențe
    de reconciliere" line sits in the served rows/sections/totals, so
    ``total_assets()`` / ``total_liabilities()`` / ``current_*()`` /
    ``difference()`` already include it.
  · ``pnl``-placed reconciliation → the delta reaches ``equity()``
    through the served result row; ``net_result()`` includes it, the
    ``revenue()`` side includes a ``pl_other_income`` delta, and
    ``expenses()`` (defined as revenue − net result) absorbs a
    ``pl_other_expense`` delta.
No other engine module may re-implement any of this arithmetic
(enforced by scripts/check_import_boundary.py).

Two source tiers, one authority object (mirrors the serve hook in
``pipeline._apply_envelope_truth_to_statements``):
  · tier ``canonical_bs`` — envelope carries a usable ``canonical_bs``:
    served verbatim; totals/rows/sections read from the SERVED copy.
  · tier ``methodology`` — legacy (pre-canonical_bs) envelopes: totals
    come from the persisted ``methodology.totals`` (the Fix-A1
    authority). No reconciliation machinery exists for these periods,
    so raw == adjusted by construction; row/section/net-result
    accessors raise :class:`MissingFactError`.
``FactsGateway.from_envelope`` returns ``None`` when the envelope
carries neither authority (pre-F4.1e periods keep their legacy path).

RAW ACCESSORS (``raw_total_assets()`` / ``raw_equity()`` / ``raw_*``)
expose the PRE-adjustment source cents — the persisted extraction
truth, never overwritten by any reconciliation. The ONLY permitted
callers are audit/receipt/undo surfaces: ``engine.api._reconcile``
(receipt construction, undo's "serve the TRUE source imbalance") and
offline audit tooling under ``scripts/`` + ``tests/``. Product surfaces
(valuation, briefing, metrics, API serializers) MUST use the adjusted
accessors. The CI boundary (scripts/check_import_boundary.py + the
raw-boundary test in tests/engine/test_facts_gateway.py) enforces this.

ADDITIVE-ONLY SERVE GUARD (``additive_serve_violations`` /
``assert_additive_serve``): a serve-stage mutation may only ADD keys
(or update values type-stably) on top of the pipeline-produced object —
it must never remove or retype a pipeline-produced field. Allowed by
construction: new keys (incl. the documented ``needs_review``
boolean-when-not-array stamp — an add); disallowed: removals and
retypes (incl. the AI-lane ``needs_review`` array being replaced by a
boolean — the array-preserve guard). Lists compare type-only (the
synthetic reconciliation row may be inserted mid-list); dicts recurse.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

from . import access_log  # E1 access-log seam (append-only, never raises)

#: Served-envelope contract version, stamped by the serve path
#: (engine.api._reconcile.served_canonical_bs) onto every served
#: canonical_bs as ``envelope_version``. Bump ONLY with a migration
#: note in docs/served_envelope.schema.json (see the schema snapshot
#: test in tests/engine/test_envelope_contract.py).
ENVELOPE_VERSION = "sv1"

#: Gateway-internal snapshot field names. scripts/check_import_boundary.py
#: reads this list via AST and greps the whole engine + frontend for the
#: names — any reference outside src/engine/serving/ (and the allowlist)
#: fails CI.
PRIVATE_SNAPSHOT_FIELDS = ["_raw_totals", "_adjusted_totals", "_summary_indicators",
                           "_market"]

#: The two result-row ids of the served balance sheet (kept literal so
#: the gateway never imports the serve module at import time; the value
#: is locked by tests against _reconcile._RESULT_ROW_IDS).
_RESULT_ROW_IDS = ("current_year_profit", "current_year_loss")

_TOTAL_CONCEPTS = (
    "assets",
    "equity",
    "liabilities",
    "equity_plus_liabilities",
    "current_assets",
    "current_liabilities",
)


class MissingFactError(KeyError):
    """The served envelope does not carry the requested concept (e.g.
    ``net_result()`` on a legacy methodology-tier envelope, or an
    unknown ``statement_line`` id). Callers that can degrade catch this
    and fall back explicitly — the gateway never fabricates a zero."""


class AdditiveServeViolation(AssertionError):
    """A serve-stage mutation removed or retyped a pipeline-produced
    field — forbidden by the sv1 additive-only serve contract."""


@dataclass(frozen=True)
class LockedRatio:
    """PS5 — a typed PAYWALL refusal, distinct from :class:`MissingFactError`.

    Returned (never raised) by account-level accessors on the
    public-summary tier: the underlying value EXISTS in principle but a
    reduced open-data filing (data.gov.ro I1..I20 indicators) cannot
    carry the account-level detail needed to compute it — a trial
    balance can. MissingFactError stays "the served envelope does not
    carry the concept" (callers degrade); LockedRatio is "upload the
    trial balance to unlock" (callers render the upsell). NEVER carries
    any numeric value — a locked ratio has no number to leak."""

    ratio_id: str
    upsell_key: str
    locked: bool = True
    reason: str = "needs_trial_balance"


@dataclass(frozen=True)
class MarketRefusal:
    """PM — a typed REFUSAL on the public_market tier: the metric cannot
    be computed because an INPUT IS ABSENT from the deterministic feed.

    Distinct from both siblings, deliberately:
      · :class:`MissingFactError` is "this tier has never carried that
        concept" (callers degrade quietly);
      · :class:`LockedRatio` is "the value exists but the open-data tier
        cannot carry it — upload a trial balance" (callers upsell);
      · ``MarketRefusal`` is "the feed did not publish input X, so the
        number does not exist to be shown" (callers render the gap and
        NAME the missing input).

    Returned, never raised — a card that must display "enterprise value
    unavailable: no cash figure in this feed" needs the reason, not a
    stack trace. NEVER carries any numeric value: a refusal with a
    number in it is a partial answer, and a partial market metric is
    indistinguishable from a wrong one.
    """

    metric_id: str
    code: str
    missing: Tuple[str, ...] = ()
    detail: str = ""

    @property
    def refused(self) -> bool:
        return True


@dataclass(frozen=True)
class MarketRatio:
    """A market ratio as an EXACT integer pair — division happens only at
    :meth:`to_float`, the serialization boundary, exactly like
    :meth:`Fact.to_float`. The gateway itself does no float arithmetic,
    so a P/E is reproducible to the last cent of its inputs."""

    ratio_id: str
    numerator_minor: int
    denominator_minor: int
    currency: str
    provenance: Dict[str, Any]

    def to_float(self) -> float:
        return self.numerator_minor / float(self.denominator_minor)


#: Market metric ids, in render order for ``market_metrics()``.
_MARKET_METRICS = ("price", "market_cap", "enterprise_value", "pe", "ev_ebitda")

#: Refusal codes this tier emits. Stable strings — surfaces group on them.
MARKET_REFUSAL_INPUT_ABSENT = "input_absent"
MARKET_REFUSAL_PRICE_ABSENT = "price_absent"
MARKET_REFUSAL_CURRENCY_MISMATCH = "currency_mismatch"
MARKET_REFUSAL_NON_POSITIVE = "non_positive_denominator"

#: Figure names the market accessors read out of a pm1 envelope. Named
#: here so a feed that starts publishing one of the absent ones (cash,
#: ebitda) lights the metric up with no further code change.
_MARKET_FIGURE_PRICE = "price"
_MARKET_FIGURE_SHARES = "shares_outstanding"
_MARKET_FIGURE_NET_INCOME = "net_income"
_MARKET_FIGURE_TOTAL_DEBT = "total_debt"
_MARKET_FIGURE_CASH = "cash_and_equivalents"
_MARKET_FIGURE_EBITDA = "ebitda"
_MARKET_FIGURE_REVENUE = "revenue"
_MARKET_FIGURE_TOTAL_ASSETS = "total_assets"
_MARKET_FIGURE_EQUITY = "equity"


#: The account-level ratios a public summary can never compute
#: (ratio_id -> upsell_key), in render order for ``locked_ratios()``.
_SUMMARY_LOCKED_RATIOS = (
    ("dso", "upsell.public_summary.dso"),
    ("dio", "upsell.public_summary.dio"),
    ("ccc", "upsell.public_summary.ccc"),
    ("working_capital", "upsell.public_summary.working_capital"),
)


def _cents(value: Any) -> int:
    """Parse a 2-decimal currency value into exact integer cents (the
    same convention as canonical_adapter._cents / _reconcile._cents)."""
    try:
        return int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _opt_cents(value: Any) -> Optional[int]:
    """None-preserving cents parse — for fields whose ABSENCE matters
    (legacy methodology totals may lack current_assets/liabilities)."""
    if value is None:
        return None
    return _cents(value)


class Fact(object):
    """One served financial fact.

    amount_minor  — integer minor units (cents). The ONLY numeric field;
                    the gateway does no float arithmetic.
    currency      — ISO code of the source statements (e.g. "RON").
    provenance    — {"snapshot_id": <envelope ref: provenance
                    content_hash, else source_document_id, else None>,
                    "line_id": <served row/section id, or None for
                    statement-level totals>}.
    """

    __slots__ = ("amount_minor", "currency", "provenance")

    def __init__(self, amount_minor: int, currency: str,
                 provenance: Dict[str, Any]) -> None:
        self.amount_minor = int(amount_minor)
        self.currency = currency
        self.provenance = provenance

    def to_float(self) -> float:
        """Serialization boundary: the 2-decimal float consumers render.
        The division happens HERE, on the way out — never inside the
        gateway's arithmetic."""
        return self.amount_minor / 100.0

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return "Fact(amount_minor=%d, currency=%r, provenance=%r)" % (
            self.amount_minor, self.currency, self.provenance,
        )


class FactsGateway(object):
    """Typed accessors over ONE served canonical envelope. Construct via
    :meth:`from_envelope`; never mutate the returned Facts."""

    TIER_CANONICAL = "canonical_bs"
    TIER_METHODOLOGY = "methodology"
    #: Third tier — reduced open-data filings (data.gov.ro bilant
    #: indicators) served from ``envelope["public_summary"]`` (ps1).
    #: Never enters the canonical status ladder / reconcile / consensus.
    TIER_SUMMARY = "public_summary"
    #: Fourth tier — GLOBAL PUBLIC MARKETS (pm1 envelopes from
    #: ``engine.public_market``: EDGAR / ESEF / provider feeds). A
    #: SIBLING of the summary tier, not a rung of the canonical ladder:
    #: it never enters reconcile / packs / consensus, it carries no
    #: balance verdict, and every metric it cannot compute is a typed
    #: :class:`MarketRefusal` rather than a derived number.
    TIER_MARKET = "public_market"

    def __init__(self, *, tier: str, served: Optional[Dict[str, Any]],
                 raw_cbs: Optional[Dict[str, Any]],
                 methodology: Dict[str, Any],
                 snapshot_id: Optional[str], currency: str,
                 summary: Optional[Dict[str, Any]] = None,
                 market: Optional[Dict[str, Any]] = None) -> None:
        self.tier = tier
        self._served = served
        self._raw_cbs = raw_cbs
        self._methodology = methodology or {}
        self._snapshot_id = snapshot_id
        self._currency = currency
        self._summary = summary if isinstance(summary, dict) else None
        self._summary_indicators = dict(
            (self._summary or {}).get("indicators") or {}
        )
        #: The whole pm1 envelope on the market tier (figures live on it
        #: with per-figure provenance); None on every other tier.
        self._market = market if isinstance(market, dict) else None
        # Concept -> Optional[int] cents, resolved once at construction.
        if tier == self.TIER_MARKET:
            # A market feed publishes statement TOTALS it actually saw.
            # Liabilities are deliberately NOT derived as assets − equity:
            # a subtraction that always "works" is exactly how a feed gap
            # becomes a confident wrong total.
            self._raw_totals = self._market_totals_cents(self._market or {})
            self._adjusted_totals = dict(self._raw_totals)
        elif tier == self.TIER_SUMMARY:
            # No reconciliation machinery exists for public summaries:
            # raw == adjusted by construction.
            self._raw_totals = self._summary_totals_cents(self._summary or {})
            self._adjusted_totals = dict(self._raw_totals)
        else:
            self._raw_totals = self._totals_cents(raw_cbs, methodology, tier)
            self._adjusted_totals = (
                self._totals_cents(served, methodology, tier)
                if tier == self.TIER_CANONICAL
                # Legacy tier has no reconciliation machinery: raw == adjusted.
                else dict(self._raw_totals)
            )

    # ── Construction ───────────────────────────────────────────────────

    @classmethod
    def from_envelope(cls, envelope: Any,
                      currency: str = "RON") -> Optional["FactsGateway"]:
        """Build the gateway for one persisted ``assembled_canonical_v1``
        envelope. Runs the REAL serve path (``served_canonical_bs``) so
        the adjusted views are exactly what /api/period serves. Returns
        None when the envelope carries neither a usable canonical_bs nor
        legacy methodology totals (pre-F4.1e periods)."""
        if not isinstance(envelope, dict):
            return None
        snapshot_id = cls._snapshot_id_of(envelope)
        access_log.record_access(doc=snapshot_id, accessor="FactsGateway.from_envelope")
        # MARKET probe (PM): a pm1 public_market envelope resolves to the
        # market tier and NOTHING else. Structural (doc_class + status +
        # figures), never version-pinned, so a pm2 document is still
        # refused entry to the canonical path. The currency comes from
        # the DOCUMENT (a US filing is USD whatever the caller's display
        # preference says) — passing `currency` cannot relabel a figure.
        if cls._is_market_envelope(envelope):
            return cls(
                tier=cls.TIER_MARKET,
                served=None,
                raw_cbs=None,
                methodology={},
                snapshot_id=snapshot_id or cls._market_snapshot_id_of(envelope),
                currency=cls._market_currency_of(envelope, currency),
                market=envelope,
            )
        # SUMMARY probe FIRST (PS): a public_summary envelope resolves to
        # the summary tier even if a canonical_bs-shaped block was ever
        # attached for convenience — public open data must never be
        # dressed up as a served balance sheet. This branch never touches
        # the serve path (no engine.api import, no reconcile machinery).
        summary = envelope.get("public_summary")
        if isinstance(summary, dict) and isinstance(summary.get("indicators"), dict):
            return cls(
                tier=cls.TIER_SUMMARY,
                served=None,
                raw_cbs=None,
                methodology={},
                snapshot_id=snapshot_id or cls._summary_snapshot_id_of(summary),
                currency=currency,
                summary=summary,
            )
        methodology = envelope.get("methodology") or {}
        # Lazy import: engine.serving must stay importable without the
        # API package; the serve path lives with _reconcile (the module
        # this gateway wraps, which itself imports engine.serving).
        from engine.api._reconcile import served_canonical_bs
        served = served_canonical_bs(envelope)
        if isinstance(served, dict):
            return cls(
                tier=cls.TIER_CANONICAL,
                served=served,
                raw_cbs=envelope.get("canonical_bs"),
                methodology=methodology,
                snapshot_id=snapshot_id,
                currency=currency,
            )
        legacy_totals = (methodology.get("totals") or {}) if isinstance(methodology, dict) else {}
        if all(
            legacy_totals.get(k) is not None
            for k in ("total_assets", "total_liabilities", "total_equity")
        ):
            return cls(
                tier=cls.TIER_METHODOLOGY,
                served=None,
                raw_cbs=None,
                methodology=methodology,
                snapshot_id=snapshot_id,
                currency=currency,
            )
        return None

    @staticmethod
    def _snapshot_id_of(envelope: Dict[str, Any]) -> Optional[str]:
        provenance = envelope.get("provenance") or {}
        for key in ("content_hash", "source_document_id"):
            value = provenance.get(key)
            if value:
                return str(value)
        return None

    @staticmethod
    def _summary_snapshot_id_of(summary: Dict[str, Any]) -> Optional[str]:
        """ps1 envelopes carry provenance INSIDE the public_summary block
        (provenance.content_hash — the ingest-time IR hash)."""
        provenance = summary.get("provenance") or {}
        value = provenance.get("content_hash") if isinstance(provenance, dict) else None
        return str(value) if value else None

    # ── Market tier (PM: pm1 public_market envelopes) ──────────────────

    @staticmethod
    def _is_market_envelope(envelope: Any) -> bool:
        """Structural pm1 probe — the same shape
        ``engine.public_market.model.is_public_market_envelope`` and
        ``engine.api._reconcile.is_public_market_envelope`` test. Kept
        literal here (no import) for the same reason ``_RESULT_ROW_IDS``
        is literal: the gateway must stay importable without the
        public_market package. A test locks the three copies together."""
        if not isinstance(envelope, dict):
            return False
        if envelope.get("doc_class") != "public_market":
            return False
        if envelope.get("status") != "PUBLIC_MARKET":
            return False
        return isinstance(envelope.get("figures"), dict)

    @staticmethod
    def _market_snapshot_id_of(envelope: Dict[str, Any]) -> Optional[str]:
        """pm1 stamps its own top-level ``content_hash`` (canonical
        sorted-key digest of the document)."""
        value = envelope.get("content_hash")
        return str(value) if value else None

    @classmethod
    def _market_currency_of(cls, envelope: Dict[str, Any],
                            fallback: str) -> str:
        """The document's own currency: the registry-stamped ``market``
        block first, then any monetary figure's currency. Falls back to
        the caller's value only when the document names none — and the
        accessors still refuse on a currency mismatch, so a wrong
        fallback can never silently relabel a figure."""
        market = envelope.get("market")
        if isinstance(market, dict):
            value = market.get("currency")
            if isinstance(value, str) and value:
                return value
        figures = envelope.get("figures")
        if isinstance(figures, dict):
            for name in sorted(figures):
                figure = figures[name]
                if isinstance(figure, dict):
                    value = figure.get("currency")
                    if isinstance(value, str) and value:
                        return value
        return fallback

    @classmethod
    def _market_totals_cents(cls, envelope: Dict[str, Any]
                             ) -> Dict[str, Optional[int]]:
        """Statement totals the market feed ACTUALLY published, in
        integer minor units. Everything else stays None — and
        ``_total`` turns None into :class:`MissingFactError`, never a
        zero. Notably ``liabilities`` / ``equity_plus_liabilities`` /
        ``current_*`` are absent for EDGAR companyfacts: the feed does
        not tag them, and assets − equity is a derivation, not a fact."""
        out: Dict[str, Optional[int]] = {k: None for k in _TOTAL_CONCEPTS}
        out["assets"] = cls._market_figure_minor(
            envelope, _MARKET_FIGURE_TOTAL_ASSETS)
        out["equity"] = cls._market_figure_minor(envelope, _MARKET_FIGURE_EQUITY)
        return out

    @staticmethod
    def _market_figure(envelope: Any, name: str) -> Optional[Dict[str, Any]]:
        if not isinstance(envelope, dict):
            return None
        figures = envelope.get("figures")
        if not isinstance(figures, dict):
            return None
        figure = figures.get(name)
        return figure if isinstance(figure, dict) else None

    @classmethod
    def _market_figure_minor(cls, envelope: Any, name: str) -> Optional[int]:
        """Integer minor units of one MONETARY market figure, or None.

        A non-int ``value_minor`` returns None rather than being coerced:
        a float in a minor-units field is a rounding bug, and rounding it
        here would launder it into a served number."""
        figure = cls._market_figure(envelope, name)
        if figure is None:
            return None
        value = figure.get("value_minor")
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value

    @classmethod
    def _market_figure_count(cls, envelope: Any, name: str) -> Optional[int]:
        """Integer COUNT of one non-monetary market figure (shares).
        A separate accessor on purpose: a share count must never travel
        through the minor-units path, where 14 594 180 000 shares would
        read as 145 941 800.00 of something."""
        figure = cls._market_figure(envelope, name)
        if figure is None:
            return None
        value = figure.get("value")
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value

    @classmethod
    def _totals_cents(cls, cbs: Optional[Dict[str, Any]],
                      methodology: Dict[str, Any],
                      tier: str) -> Dict[str, Optional[int]]:
        out: Dict[str, Optional[int]] = {k: None for k in _TOTAL_CONCEPTS}
        if tier == cls.TIER_CANONICAL:
            totals = (cbs or {}).get("totals") or {}
            for key in _TOTAL_CONCEPTS:
                out[key] = _opt_cents(totals.get(key))
            if out["equity_plus_liabilities"] is None and (
                out["equity"] is not None and out["liabilities"] is not None
            ):
                out["equity_plus_liabilities"] = out["equity"] + out["liabilities"]
        elif tier == cls.TIER_METHODOLOGY:
            totals = (methodology or {}).get("totals") or {}
            out["assets"] = _opt_cents(totals.get("total_assets"))
            out["equity"] = _opt_cents(totals.get("total_equity"))
            out["liabilities"] = _opt_cents(totals.get("total_liabilities"))
            if out["equity"] is not None and out["liabilities"] is not None:
                out["equity_plus_liabilities"] = out["equity"] + out["liabilities"]
            out["current_assets"] = _opt_cents(totals.get("current_assets"))
            out["current_liabilities"] = _opt_cents(totals.get("current_liabilities"))
        else:
            # EXPLICIT tier dispatch — a new tier must never silently fall
            # into the methodology branch and read None-filled totals.
            # (The summary tier resolves via _summary_totals_cents in
            # __init__ and never reaches this method.)
            raise ValueError("unknown FactsGateway tier %r" % tier)
        return out

    @staticmethod
    def _summary_ron_cents(value: Any, what: str) -> Optional[int]:
        """STRICT whole-RON int -> cents. None (absent in the source
        file) stays None; anything that is not an exact int is REFUSED —
        never the ``_cents()`` swallow-to-0 (a data.gov.ro string like
        "1.234.567" must fail loudly at ingest, not read as 0 here)."""
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise MissingFactError(
                "public_summary %s must be an exact whole-RON int, got %s"
                % (what, type(value).__name__)
            )
        return value * 100

    @classmethod
    def _summary_totals_cents(cls, summary: Dict[str, Any]) -> Dict[str, Optional[int]]:
        """Totals of the ps1 indicator layout (VERIFIED FY2019-FY2025):
        assets = derived.total_assets (I1+I2+I6, precomputed at build
        time; recomputed here as fallback), equity = I10 CAPITALURI
        TOTAL (NOT capitaluri proprii — the mass file has no separate
        own-equity column; label honestly), liabilities = I7 DATORII.

        equity_plus_liabilities stays None ON PURPOSE: I10 + I7 omits I8
        (venituri in avans) and I9 (provizioane), so summing them would
        mint a fake balance identity and a fake ``difference()``. The
        current_* splits also stay None — I7 has no maturity split (the
        working-capital detail is exactly what LockedRatio gates)."""
        indicators = summary.get("indicators") or {}
        derived = summary.get("derived") if isinstance(summary.get("derived"), dict) else {}
        out: Dict[str, Optional[int]] = {k: None for k in _TOTAL_CONCEPTS}

        def _tolerant(value: Any, what: str) -> Optional[int]:
            # Construction never raises (from_envelope's contract is
            # Optional-gateway, never an exception): a malformed value
            # resolves to None here, which every accessor REFUSES with
            # MissingFactError at access time — never a fabricated zero.
            try:
                return cls._summary_ron_cents(value, what)
            except MissingFactError:
                return None

        assets = _tolerant(derived.get("total_assets"), "derived.total_assets")
        if assets is None:
            components = [
                _tolerant(indicators.get(code), code)
                for code in ("I1", "I2", "I6")
            ]
            present = [c for c in components if c is not None]
            if present:
                assets = sum(present)
        out["assets"] = assets
        out["equity"] = _tolerant(indicators.get("I10"), "I10")
        out["liabilities"] = _tolerant(indicators.get("I7"), "I7")
        return out

    # ── The served canonical_bs object (verbatim serve payload) ────────

    @property
    def served_canonical_bs(self) -> Optional[Dict[str, Any]]:
        """The exact object /api/period serves as ``statements.
        canonical_bs`` (None on the legacy methodology tier). Callers
        attach it to responses; they never recompute totals from it —
        that is what the accessors below are for."""
        return self._served

    # ── Internals ──────────────────────────────────────────────────────

    def _fact(self, cents: int, line_id: Optional[str] = None) -> Fact:
        return Fact(cents, self._currency, {
            "snapshot_id": self._snapshot_id,
            "line_id": line_id,
        })

    def _total(self, concept: str, totals: Dict[str, Optional[int]]) -> Fact:
        cents = totals.get(concept)
        if cents is None:
            raise MissingFactError(
                "served envelope carries no '%s' (tier=%s)" % (concept, self.tier)
            )
        return self._fact(cents)

    def _receipt(self) -> Optional[Dict[str, Any]]:
        if self._served is None or self._served.get("status") != "RECONCILED":
            return None
        receipt = self._served.get("reconciliation")
        return receipt if isinstance(receipt, dict) else None

    def _pnl_delta_cents(self) -> int:
        """Signed cents of a P&L-placed reconciliation adjustment, else 0.
        (A balance_sheet-placed adjustment is already inside the served
        rows/sections/totals and must NOT be added again.)"""
        receipt = self._receipt()
        if receipt is None or str(receipt.get("placement") or "") != "pnl":
            return 0
        try:
            return int(receipt.get("amount_cents"))
        except (TypeError, ValueError):
            return _cents(receipt.get("applied_delta"))

    def _result_rows_cents(self, cbs: Optional[Dict[str, Any]]) -> Optional[int]:
        """Sum of the result-row amounts, or None when no result row
        exists in the given canonical_bs."""
        if not isinstance(cbs, dict):
            return None
        found = False
        cents = 0
        for row in cbs.get("rows") or []:
            if str(row.get("id") or "") in _RESULT_ROW_IDS:
                cents += _cents(row.get("amount"))
                found = True
        return cents if found else None

    def _methodology_cents(self, path: str) -> Optional[int]:
        """Cents of one methodology view value ("totals.revenue_net",
        "ebitda.reported"), or None when absent."""
        namespace, _, name = path.partition(".")
        bag = self._methodology.get(namespace)
        if not isinstance(bag, dict) or bag.get(name) is None:
            return None
        return _cents(bag.get(name))

    # ── Adjusted accessors (reconciliation-INCLUSIVE — the product view) ──

    def total_assets(self) -> Fact:
        return self._total("assets", self._adjusted_totals)

    def total_liabilities(self) -> Fact:
        return self._total("liabilities", self._adjusted_totals)

    def equity(self) -> Fact:
        return self._total("equity", self._adjusted_totals)

    def equity_plus_liabilities(self) -> Fact:
        return self._total("equity_plus_liabilities", self._adjusted_totals)

    def current_assets(self) -> Fact:
        return self._total("current_assets", self._adjusted_totals)

    def current_liabilities(self) -> Fact:
        return self._total("current_liabilities", self._adjusted_totals)

    def working_capital(self) -> Union[Fact, "LockedRatio"]:
        """Canonical/methodology tiers: current assets − current
        liabilities (Fact), exactly as before. Summary tier: a
        :class:`LockedRatio` — the mass bilant file's I7 DATORII has no
        maturity split, so the detail genuinely exists only in a trial
        balance (PS5 paywall refusal, never a fabricated number)."""
        if self.tier == self.TIER_SUMMARY:
            return self._locked("working_capital")
        ca = self._total("current_assets", self._adjusted_totals)
        cl = self._total("current_liabilities", self._adjusted_totals)
        return self._fact(ca.amount_minor - cl.amount_minor)

    def difference(self) -> Fact:
        """assets − (equity + liabilities) of the SERVED statement —
        exactly 0 on BALANCED and RECONCILED servings."""
        if self.tier == self.TIER_CANONICAL and isinstance(self._served, dict) \
                and self._served.get("difference") is not None:
            return self._fact(_cents(self._served.get("difference")))
        ta = self._total("assets", self._adjusted_totals)
        el = self._total("equity_plus_liabilities", self._adjusted_totals)
        return self._fact(ta.amount_minor - el.amount_minor)

    def net_result(self) -> Fact:
        """Current-year result as SERVED: the result row (already
        adjusted on a pnl-placed reconciliation), or — when the
        statement has no result row — the pnl-placed delta alone (the
        serve path parks it as a synthetic equity row in that case).
        0 when neither exists on a canonical-tier envelope.

        Summary tier: ``derived.net_result`` (ingest-precomputed) or
        I18 − I19 (Profit net − Pierdere neta, both non-negative
        columns); REFUSES when both result columns are absent.

        Market tier: the feed's own ``net_income`` figure, verbatim in
        minor units — never derived from revenue and expenses, which the
        feed may have tagged for different periods."""
        if self.tier == self.TIER_MARKET:
            cents = self._market_figure_minor(
                self._market, _MARKET_FIGURE_NET_INCOME)
            if cents is None:
                raise MissingFactError(
                    "public_market feed carries no %s figure"
                    % _MARKET_FIGURE_NET_INCOME
                )
            return self._fact(cents, line_id=_MARKET_FIGURE_NET_INCOME)
        if self.tier == self.TIER_SUMMARY:
            cents = self._summary_ron_cents(
                ((self._summary or {}).get("derived") or {}).get("net_result")
                if isinstance((self._summary or {}).get("derived"), dict)
                else None,
                "derived.net_result",
            )
            if cents is not None:
                return self._fact(cents, line_id="derived.net_result")
            profit = self._summary_ron_cents(
                self._summary_indicators.get("I18"), "I18")
            loss = self._summary_ron_cents(
                self._summary_indicators.get("I19"), "I19")
            if profit is None and loss is None:
                raise MissingFactError(
                    "public_summary carries neither I18 nor I19 — the "
                    "gateway never fabricates a zero result"
                )
            return self._fact((profit or 0) - (loss or 0), line_id="I18-I19")
        if self.tier != self.TIER_CANONICAL:
            raise MissingFactError(
                "net_result requires a canonical_bs serving (tier=%s)" % self.tier
            )
        row_cents = self._result_rows_cents(self._served)
        if row_cents is not None:
            return self._fact(row_cents)
        return self._fact(self._pnl_delta_cents())

    def revenue(self) -> Fact:
        """Net revenue (methodology ``totals.revenue_net``) plus a
        ``pl_other_income``-placed reconciliation delta. Summary tier:
        I13 (Cifra de afaceri neta) — its own resolution, deliberately
        NOT the methodology path's asymmetric positive-delta rule.

        Market tier: the feed's own ``revenue`` figure, verbatim."""
        if self.tier == self.TIER_MARKET:
            cents = self._market_figure_minor(self._market, _MARKET_FIGURE_REVENUE)
            if cents is None:
                raise MissingFactError(
                    "public_market feed carries no %s figure" % _MARKET_FIGURE_REVENUE
                )
            return self._fact(cents, line_id=_MARKET_FIGURE_REVENUE)
        if self.tier == self.TIER_SUMMARY:
            cents = self._summary_ron_cents(
                self._summary_indicators.get("I13"), "I13")
            if cents is None:
                raise MissingFactError("public_summary carries no I13 (net turnover)")
            return self._fact(cents, line_id="I13")
        base = self._methodology_cents("totals.revenue_net")
        if base is None:
            raise MissingFactError("envelope carries no methodology revenue_net")
        delta = self._pnl_delta_cents()
        return self._fact(base + delta if delta > 0 else base)

    def expenses(self) -> Fact:
        """Total expense burden implied by the served statement:
        revenue − net_result. Absorbs a ``pl_other_expense``-placed
        reconciliation delta by construction (revenue is unchanged,
        net_result shrinks). Summary tier: I15 (Cheltuieli totale) —
        the file's own column, not an implied figure."""
        if self.tier == self.TIER_MARKET:
            # revenue − net_income across a market feed is NOT expenses:
            # the two figures can come from different filings, different
            # fiscal spans and different concept chains, so the
            # subtraction would produce a confident number nobody
            # published. The market tier refuses instead.
            raise MissingFactError(
                "expenses is not a served concept on the public_market tier — "
                "revenue − net_income would be a derived total the feed never "
                "published (tier=%s)" % self.tier
            )
        if self.tier == self.TIER_SUMMARY:
            cents = self._summary_ron_cents(
                self._summary_indicators.get("I15"), "I15")
            if cents is None:
                raise MissingFactError("public_summary carries no I15 (total expenses)")
            return self._fact(cents, line_id="I15")
        rev = self.revenue()
        result = self.net_result()
        return self._fact(rev.amount_minor - result.amount_minor)

    # ── Summary-tier accessors (PS: public_summary envelopes only) ─────

    def employees(self) -> int:
        """Average employee headcount (I20) as a PLAIN int — a count is
        not Money; serving it as Fact cents (3700 meaning 37 people)
        would be a trap. Summary tier only."""
        if self.tier != self.TIER_SUMMARY:
            raise MissingFactError(
                "employees requires a public_summary envelope (tier=%s)" % self.tier
            )
        value = self._summary_indicators.get("I20")
        if value is None:
            raise MissingFactError("public_summary carries no I20 (employees)")
        if isinstance(value, bool) or not isinstance(value, int):
            raise MissingFactError(
                "public_summary I20 must be an exact int, got %s"
                % type(value).__name__
            )
        return value

    def summary_derived(self) -> Dict[str, Any]:
        """The ps1 ``derived`` block (margins / growth / precomputed
        totals, built at ingest time) — a defensive copy. Empty dict on
        non-summary tiers."""
        if self.tier != self.TIER_SUMMARY:
            return {}
        derived = (self._summary or {}).get("derived")
        return copy.deepcopy(derived) if isinstance(derived, dict) else {}

    def _locked(self, ratio_id: str) -> "LockedRatio":
        for rid, upsell_key in _SUMMARY_LOCKED_RATIOS:
            if rid == ratio_id:
                return LockedRatio(ratio_id=rid, upsell_key=upsell_key)
        raise MissingFactError("unknown locked ratio %r" % ratio_id)

    def dso(self) -> "LockedRatio":
        """Days sales outstanding needs receivables detail — summary
        tier returns the PS5 :class:`LockedRatio`; every other tier
        refuses with MissingFactError (the gateway has never carried
        this concept — a paywall must not appear where the value is
        simply absent)."""
        if self.tier == self.TIER_SUMMARY:
            return self._locked("dso")
        raise MissingFactError("dso is not a served concept (tier=%s)" % self.tier)

    def dio(self) -> "LockedRatio":
        """Days inventory outstanding — see :meth:`dso`."""
        if self.tier == self.TIER_SUMMARY:
            return self._locked("dio")
        raise MissingFactError("dio is not a served concept (tier=%s)" % self.tier)

    def ccc(self) -> "LockedRatio":
        """Cash conversion cycle — see :meth:`dso`."""
        if self.tier == self.TIER_SUMMARY:
            return self._locked("ccc")
        raise MissingFactError("ccc is not a served concept (tier=%s)" % self.tier)

    def locked_ratios(self) -> List["LockedRatio"]:
        """Every PS5 locked refusal of this tier, in render order — the
        public page renderer iterates this to draw the upsell cards.
        Empty on non-summary tiers (nothing is paywalled there)."""
        if self.tier != self.TIER_SUMMARY:
            return []
        return [LockedRatio(ratio_id=rid, upsell_key=key)
                for rid, key in _SUMMARY_LOCKED_RATIOS]

    # ── Market-tier accessors (PM: pm1 public_market envelopes only) ───
    #
    # Every one of these is DETERMINISTIC INTEGER ARITHMETIC over feed
    # values. No AI touches a digit here — the AI lane carries freshness,
    # narrative and resolution, never a number on a market card.
    #
    # Each returns either a value object or a typed :class:`MarketRefusal`
    # naming the missing input. None of them ever substitutes a zero, and
    # none of them ever partially computes: enterprise value without a
    # cash figure is not "enterprise value minus nothing", it is a
    # refusal, because the market has no way to tell the difference
    # between a company with no cash and a feed that never tagged it.

    def _require_market_tier(self, metric_id: str) -> None:
        if self.tier != self.TIER_MARKET:
            raise MissingFactError(
                "%s requires a public_market serving (tier=%s)"
                % (metric_id, self.tier)
            )

    def _market_refuse(self, metric_id: str, code: str,
                       missing: Tuple[str, ...] = (),
                       detail: str = "") -> "MarketRefusal":
        return MarketRefusal(metric_id=metric_id, code=code,
                             missing=tuple(missing), detail=detail)

    def _market_provenance(self, *figure_names: str) -> Dict[str, Any]:
        """Provenance for a COMPOSED market metric: the snapshot plus the
        exact figures it consumed. A derived number must be able to name
        every input it stood on."""
        return {"snapshot_id": self._snapshot_id,
                "line_id": None,
                "inputs": list(figure_names)}

    def _market_currency_conflict(self, *figure_names: str) -> Optional[str]:
        """The first figure whose currency disagrees with the document's,
        or None. Mixing currencies in a market cap is the single easiest
        way to publish a number that is wrong by a factor of five."""
        for name in figure_names:
            figure = self._market_figure(self._market, name)
            if figure is None:
                continue
            currency = figure.get("currency")
            if isinstance(currency, str) and currency and currency != self._currency:
                return name
        return None

    def market_price(self) -> Union[Fact, "MarketRefusal"]:
        """The last labeled price, in integer minor units.

        The price block's ABSENCE is a DESIGNED state (keyless mode — the
        platform holds no market-data licence), so this refuses with
        ``price_absent`` rather than raising: "no licensed price" is a
        thing the card says out loud, not an error."""
        self._require_market_tier("market_price")
        block = (self._market or {}).get("price")
        if not isinstance(block, dict):
            return self._market_refuse(
                "price", MARKET_REFUSAL_PRICE_ABSENT, (_MARKET_FIGURE_PRICE,),
                "no price block on this envelope — keyless (fundamentals-only) "
                "mode, or no licensed feed for this market",
            )
        minor = block.get("price_minor")
        if isinstance(minor, bool) or not isinstance(minor, int):
            return self._market_refuse(
                "price", MARKET_REFUSAL_INPUT_ABSENT, (_MARKET_FIGURE_PRICE,),
                "price block carries no integer price_minor",
            )
        currency = block.get("currency")
        if isinstance(currency, str) and currency and currency != self._currency:
            return self._market_refuse(
                "price", MARKET_REFUSAL_CURRENCY_MISMATCH, (_MARKET_FIGURE_PRICE,),
                "price is quoted in %s but the document's currency is %s"
                % (currency, self._currency),
            )
        return self._fact(minor, line_id=_MARKET_FIGURE_PRICE)

    def market_cap(self) -> Union[Fact, "MarketRefusal"]:
        """price × shares outstanding, exactly, in integer minor units.

        Both inputs are integers (price in minor units, shares as a
        count), so the product is exact — no float ever enters."""
        self._require_market_tier("market_cap")
        price = self.market_price()
        if isinstance(price, MarketRefusal):
            return self._market_refuse(
                "market_cap", price.code, price.missing, price.detail)
        shares = self._market_figure_count(self._market, _MARKET_FIGURE_SHARES)
        if shares is None:
            return self._market_refuse(
                "market_cap", MARKET_REFUSAL_INPUT_ABSENT,
                (_MARKET_FIGURE_SHARES,),
                "the feed published no share count — a market cap without one "
                "would be a guess at the company's size",
            )
        return Fact(price.amount_minor * shares, self._currency,
                    self._market_provenance(_MARKET_FIGURE_PRICE,
                                            _MARKET_FIGURE_SHARES))

    def enterprise_value(self) -> Union[Fact, "MarketRefusal"]:
        """market cap + total debt − cash, in integer minor units.

        Refuses when ANY leg is absent. In particular the EDGAR
        companyfacts feed does not carry a cash figure today, so this
        refuses on ``cash_and_equivalents`` by design — treating that
        absence as zero would silently overstate enterprise value by the
        whole cash balance, which for a large filer is tens of billions.
        """
        self._require_market_tier("enterprise_value")
        cap = self.market_cap()
        if isinstance(cap, MarketRefusal):
            return self._market_refuse(
                "enterprise_value", cap.code, cap.missing, cap.detail)
        debt = self._market_figure_minor(self._market, _MARKET_FIGURE_TOTAL_DEBT)
        cash = self._market_figure_minor(self._market, _MARKET_FIGURE_CASH)
        missing = []
        if debt is None:
            missing.append(_MARKET_FIGURE_TOTAL_DEBT)
        if cash is None:
            missing.append(_MARKET_FIGURE_CASH)
        if missing:
            return self._market_refuse(
                "enterprise_value", MARKET_REFUSAL_INPUT_ABSENT, tuple(missing),
                "the feed published no %s — ABSENT is not ZERO, so enterprise "
                "value is refused rather than computed from a assumed balance"
                % " and no ".join(missing),
            )
        conflict = self._market_currency_conflict(
            _MARKET_FIGURE_TOTAL_DEBT, _MARKET_FIGURE_CASH)
        if conflict is not None:
            return self._market_refuse(
                "enterprise_value", MARKET_REFUSAL_CURRENCY_MISMATCH, (conflict,),
                "%s is denominated in a different currency than the document" % conflict,
            )
        return Fact(cap.amount_minor + debt - cash, self._currency,
                    self._market_provenance(
                        _MARKET_FIGURE_PRICE, _MARKET_FIGURE_SHARES,
                        _MARKET_FIGURE_TOTAL_DEBT, _MARKET_FIGURE_CASH))

    def pe(self) -> Union["MarketRatio", "MarketRefusal"]:
        """market cap ÷ net income, as an exact integer pair.

        A non-positive denominator is REFUSED, not computed: a "P/E" over
        a loss is not a small number, it is a category error, and
        rendering one would be worse than rendering nothing."""
        self._require_market_tier("pe")
        cap = self.market_cap()
        if isinstance(cap, MarketRefusal):
            return self._market_refuse("pe", cap.code, cap.missing, cap.detail)
        earnings = self._market_figure_minor(self._market, _MARKET_FIGURE_NET_INCOME)
        if earnings is None:
            return self._market_refuse(
                "pe", MARKET_REFUSAL_INPUT_ABSENT, (_MARKET_FIGURE_NET_INCOME,),
                "the feed published no net income figure",
            )
        conflict = self._market_currency_conflict(_MARKET_FIGURE_NET_INCOME)
        if conflict is not None:
            return self._market_refuse(
                "pe", MARKET_REFUSAL_CURRENCY_MISMATCH, (conflict,),
                "net income is denominated in a different currency than the price",
            )
        if earnings <= 0:
            return self._market_refuse(
                "pe", MARKET_REFUSAL_NON_POSITIVE, (_MARKET_FIGURE_NET_INCOME,),
                "net income is not positive — a P/E over a loss is undefined, "
                "not small",
            )
        return MarketRatio(
            ratio_id="pe", numerator_minor=cap.amount_minor,
            denominator_minor=earnings, currency=self._currency,
            provenance=self._market_provenance(
                _MARKET_FIGURE_PRICE, _MARKET_FIGURE_SHARES,
                _MARKET_FIGURE_NET_INCOME),
        )

    def ev_ebitda(self) -> Union["MarketRatio", "MarketRefusal"]:
        """enterprise value ÷ EBITDA, as an exact integer pair.

        EBITDA is not a tagged concept in the statement feeds wired
        today, so this refuses on ``ebitda`` until a feed publishes one.
        Deriving EBITDA from a summary feed (operating income plus a
        depreciation line that may not exist) is exactly the kind of
        model-shaped number this document class refuses to invent."""
        self._require_market_tier("ev_ebitda")
        ev = self.enterprise_value()
        if isinstance(ev, MarketRefusal):
            return self._market_refuse(
                "ev_ebitda", ev.code, ev.missing, ev.detail)
        ebitda = self._market_figure_minor(self._market, _MARKET_FIGURE_EBITDA)
        if ebitda is None:
            return self._market_refuse(
                "ev_ebitda", MARKET_REFUSAL_INPUT_ABSENT, (_MARKET_FIGURE_EBITDA,),
                "the feed published no EBITDA figure and this tier never "
                "reconstructs one",
            )
        conflict = self._market_currency_conflict(_MARKET_FIGURE_EBITDA)
        if conflict is not None:
            return self._market_refuse(
                "ev_ebitda", MARKET_REFUSAL_CURRENCY_MISMATCH, (conflict,),
                "EBITDA is denominated in a different currency than the price",
            )
        if ebitda <= 0:
            return self._market_refuse(
                "ev_ebitda", MARKET_REFUSAL_NON_POSITIVE, (_MARKET_FIGURE_EBITDA,),
                "EBITDA is not positive — the multiple is undefined",
            )
        return MarketRatio(
            ratio_id="ev_ebitda", numerator_minor=ev.amount_minor,
            denominator_minor=ebitda, currency=self._currency,
            provenance=self._market_provenance(
                _MARKET_FIGURE_PRICE, _MARKET_FIGURE_SHARES,
                _MARKET_FIGURE_TOTAL_DEBT, _MARKET_FIGURE_CASH,
                _MARKET_FIGURE_EBITDA),
        )

    def market_metrics(self) -> "Dict[str, Any]":
        """Every market metric in render order, each resolved to its
        value object OR its typed refusal. The surface iterates this
        instead of calling five accessors and try/excepting each — the
        refusals are first-class cards, not error handling.

        Empty dict on every non-market tier."""
        if self.tier != self.TIER_MARKET:
            return {}
        resolvers = {
            "price": self.market_price,
            "market_cap": self.market_cap,
            "enterprise_value": self.enterprise_value,
            "pe": self.pe,
            "ev_ebitda": self.ev_ebitda,
        }
        return dict((metric, resolvers[metric]()) for metric in _MARKET_METRICS)

    def market_refusals(self) -> List["MarketRefusal"]:
        """Only the refused market metrics, in render order."""
        return [value for value in self.market_metrics().values()
                if isinstance(value, MarketRefusal)]

    def ebitda(self) -> Fact:
        """Reported EBITDA (methodology ``ebitda.reported``) plus a
        pnl-placed reconciliation delta — the placement vocabulary is
        other OPERATING income/expense, which reported EBITDA includes."""
        base = self._methodology_cents("ebitda.reported")
        if base is None:
            raise MissingFactError("envelope carries no methodology ebitda.reported")
        return self._fact(base + self._pnl_delta_cents())

    def statement_line(self, line_id: str) -> Fact:
        """One served balance-sheet row by id (adjusted amounts, incl.
        the synthetic reconciliation row when present)."""
        if self.tier != self.TIER_CANONICAL or not isinstance(self._served, dict):
            raise MissingFactError(
                "statement_line requires a canonical_bs serving (tier=%s)" % self.tier
            )
        for row in self._served.get("rows") or []:
            if str(row.get("id") or "") == line_id:
                return self._fact(_cents(row.get("amount")), line_id=line_id)
        raise MissingFactError("served statement has no row '%s'" % line_id)

    def section_subtotal(self, section_id: str) -> Fact:
        """One served section subtotal by id (adjusted)."""
        if self.tier != self.TIER_CANONICAL or not isinstance(self._served, dict):
            raise MissingFactError(
                "section_subtotal requires a canonical_bs serving (tier=%s)" % self.tier
            )
        for section in self._served.get("sections") or []:
            if str(section.get("id") or "") == section_id:
                return self._fact(_cents(section.get("subtotal")), line_id=section_id)
        raise MissingFactError("served statement has no section '%s'" % section_id)

    # ── Raw accessors (pre-adjustment source cents — audit surfaces ONLY) ──

    def raw_total_assets(self) -> Fact:
        return self._total("assets", self._raw_totals)

    def raw_total_liabilities(self) -> Fact:
        return self._total("liabilities", self._raw_totals)

    def raw_equity(self) -> Fact:
        return self._total("equity", self._raw_totals)

    def raw_equity_plus_liabilities(self) -> Fact:
        return self._total("equity_plus_liabilities", self._raw_totals)

    def raw_current_assets(self) -> Fact:
        return self._total("current_assets", self._raw_totals)

    def raw_current_liabilities(self) -> Fact:
        return self._total("current_liabilities", self._raw_totals)

    def raw_difference(self) -> Fact:
        """The TRUE source imbalance (what undo restores)."""
        if self.tier == self.TIER_CANONICAL and isinstance(self._raw_cbs, dict) \
                and self._raw_cbs.get("difference") is not None:
            return self._fact(_cents(self._raw_cbs.get("difference")))
        ta = self._total("assets", self._raw_totals)
        el = self._total("equity_plus_liabilities", self._raw_totals)
        return self._fact(ta.amount_minor - el.amount_minor)

    def raw_net_result(self) -> Fact:
        if self.tier != self.TIER_CANONICAL:
            raise MissingFactError(
                "raw_net_result requires a canonical_bs serving (tier=%s)" % self.tier
            )
        row_cents = self._result_rows_cents(self._raw_cbs)
        return self._fact(row_cents if row_cents is not None else 0)


# ── ADDITIVE-ONLY SERVE GUARD ──────────────────────────────────────────


def _json_type_name(value: Any) -> str:
    if isinstance(value, bool):  # before int — bool is an int subclass
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if value is None:
        return "null"
    return type(value).__name__


def additive_serve_violations(before: Any, after: Any,
                              path: str = "$") -> List[str]:
    """Generic before/after comparison for serve-stage mutations.

    Returns one message per violated field. Rules (sv1 contract):
      · every key present in ``before`` must exist in ``after``
        (removal = violation);
      · its JSON type class must be unchanged (retype = violation) —
        this includes the AI-lane ``needs_review`` array: replacing it
        with a boolean is a retype (the array-preserve guard);
      · a ``before`` value of null is a wildcard (filling a null in is
        additive); an ``after`` null over a non-null before is a retype;
      · new keys in ``after`` are always allowed (incl. the documented
        ``needs_review`` boolean stamp when the key was absent);
      · dicts recurse; lists compare type-only (the synthetic
        reconciliation row may be inserted mid-list, so positional
        deep-comparison would misalign).
    """
    violations: List[str] = []
    if not isinstance(before, dict) or not isinstance(after, dict):
        return violations
    for key in before:
        key_path = "%s.%s" % (path, key)
        if key not in after:
            violations.append("%s: removed by serve mutation" % key_path)
            continue
        b_val = before[key]
        a_val = after[key]
        if b_val is None:
            continue  # null wildcard — filling in a value is additive
        b_type = _json_type_name(b_val)
        a_type = _json_type_name(a_val)
        if b_type != a_type:
            violations.append(
                "%s: retyped %s -> %s by serve mutation" % (key_path, b_type, a_type)
            )
            continue
        if isinstance(b_val, dict):
            violations.extend(additive_serve_violations(b_val, a_val, key_path))
    return violations


def assert_additive_serve(before: Any, after: Any) -> None:
    """Raise :class:`AdditiveServeViolation` when a serve mutation
    removed or retyped a pipeline-produced field (see
    :func:`additive_serve_violations` for the rules)."""
    violations = additive_serve_violations(before, after)
    if violations:
        raise AdditiveServeViolation("; ".join(violations))


def served_copy(cbs: Dict[str, Any]) -> Dict[str, Any]:
    """Deep copy helper for serve mutations (kept here so serve-stage
    code reads declaratively)."""
    return copy.deepcopy(cbs)
