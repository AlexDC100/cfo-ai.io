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
from typing import Any, Dict, List, Optional, Union

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
PRIVATE_SNAPSHOT_FIELDS = ["_raw_totals", "_adjusted_totals", "_summary_indicators"]

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

    def __init__(self, *, tier: str, served: Optional[Dict[str, Any]],
                 raw_cbs: Optional[Dict[str, Any]],
                 methodology: Dict[str, Any],
                 snapshot_id: Optional[str], currency: str,
                 summary: Optional[Dict[str, Any]] = None) -> None:
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
        # Concept -> Optional[int] cents, resolved once at construction.
        if tier == self.TIER_SUMMARY:
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
        columns); REFUSES when both result columns are absent."""
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
        NOT the methodology path's asymmetric positive-delta rule."""
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
