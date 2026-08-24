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
from typing import Any, Dict, List, Optional

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
PRIVATE_SNAPSHOT_FIELDS = ["_raw_totals", "_adjusted_totals"]

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

    def __init__(self, *, tier: str, served: Optional[Dict[str, Any]],
                 raw_cbs: Optional[Dict[str, Any]],
                 methodology: Dict[str, Any],
                 snapshot_id: Optional[str], currency: str) -> None:
        self.tier = tier
        self._served = served
        self._raw_cbs = raw_cbs
        self._methodology = methodology or {}
        self._snapshot_id = snapshot_id
        self._currency = currency
        # Concept -> Optional[int] cents, resolved once at construction.
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
        else:
            totals = (methodology or {}).get("totals") or {}
            out["assets"] = _opt_cents(totals.get("total_assets"))
            out["equity"] = _opt_cents(totals.get("total_equity"))
            out["liabilities"] = _opt_cents(totals.get("total_liabilities"))
            if out["equity"] is not None and out["liabilities"] is not None:
                out["equity_plus_liabilities"] = out["equity"] + out["liabilities"]
            out["current_assets"] = _opt_cents(totals.get("current_assets"))
            out["current_liabilities"] = _opt_cents(totals.get("current_liabilities"))
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

    def working_capital(self) -> Fact:
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
        0 when neither exists on a canonical-tier envelope."""
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
        ``pl_other_income``-placed reconciliation delta."""
        base = self._methodology_cents("totals.revenue_net")
        if base is None:
            raise MissingFactError("envelope carries no methodology revenue_net")
        delta = self._pnl_delta_cents()
        return self._fact(base + delta if delta > 0 else base)

    def expenses(self) -> Fact:
        """Total expense burden implied by the served statement:
        revenue − net_result. Absorbs a ``pl_other_expense``-placed
        reconciliation delta by construction (revenue is unchanged,
        net_result shrinks)."""
        rev = self.revenue()
        result = self.net_result()
        return self._fact(rev.amount_minor - result.amount_minor)

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
