"""fp1 — THE WIRE CONTRACT FOR A PROJECTED FIGURE.

This module holds the SHAPE and nothing else: no arithmetic, no I/O, no
model. It is the seam between the projection engine (lane M builds
``engine.forecast``), the drivers (lane D builds ``engine.forecast_drivers``)
and every consumer, and it exists so the two sides can be written against
a written contract rather than against each other's internals.

WHY THE CONTRACT IS SEPARATE FROM THE GATEWAY
---------------------------------------------
The gateway REFUSES payloads. To refuse honestly it has to be able to say
which clause was broken, by name, in a message a reader can act on. A
contract expressed as scattered ``if`` statements cannot do that; a
contract expressed as named clauses can, and the refusal codes below are
the vocabulary the gates assert on.

THE SHAPE
---------
::

    {
      "kind": "projection",          # MANDATORY discriminant (CLAUSE_KIND)
      "contract": "fp1",
      "currency": "RON",
      "base_period": {               # a POINTER to the actual it stands on,
        "label": "FY2024",           # never a container of actual figures
        "snapshot_id": "<content hash of the book>"
      },
      "horizon": ["FY2025", "FY2026", "FY2027"],
      "assumptions": [
        {"id": "revenue_growth",
         "label": "Revenue growth",
         "unit": "pct",              # one of UNITS
         "values": {"FY2025": 0.08, "FY2026": 0.06, "FY2027": 0.05},
         "basis": "Median of the three actual years on this book",
         "derived_from": ["assembled_pl.revenue@FY2022", "...@FY2023"]}
      ],
      "figures": [
        {"line": "revenue",
         "period": "FY2025",
         "amount_minor": 1234560000,
         "assumption_ids": ["revenue_growth"],
         "formula": "base.revenue * (1 + revenue_growth[FY2025])"}
      ],
      "balance_check": [
        {"period": "FY2025", "difference_minor": 0}
      ]
    }

WHY ``amount_minor`` AND NOT A FLOAT
------------------------------------
Same reason ``engine.serving.facts.Fact`` carries integer minor units: a
projected balance sheet has to balance to the cent, and a float sum of
five figures does not reproduce. Division happens once, at the
serialization boundary, and never inside the gateway.

WHY ``assumption_ids`` IS MANDATORY AND NOT OPTIONAL
----------------------------------------------------
F4. An actual figure resolves to a source cell; a projected figure
resolves to the assumptions that produced it. A figure that names no
assumption has nothing behind it, so the gateway does not serve a number
for it — it serves a refusal. Making the field optional would make the
"nothing behind it" case indistinguishable from the "we forgot" case, and
the reader would be the one paying for the difference.

WHAT ``base_period`` MAY NOT CONTAIN
------------------------------------
Actual FIGURES. A pointer (label + snapshot id) is fine and necessary —
the reader has to know which book the projection stands on. A container
of actual figures inside a projection payload is refused
(:data:`CLAUSE_NO_ACTUAL_CONTAINERS`) because a single object that both
gateways accept is exactly the confusion this lane exists to prevent.

Python 3.9 — no ``match``, no ``X | Y`` at runtime. No imports beyond the
standard library typing module.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

__all__ = [
    "CONTRACT_VERSION",
    "KIND",
    "UNITS",
    "PRODUCER_SCHEMAS",
    "BASE_PERIOD_KEYS",
    "ACTUAL_FIGURE_CONTAINERS",
    "ACTUAL_PROVENANCE_FIELDS",
    "ProjectionContractError",
    "clause_violations",
]

#: The contract version stamped on every projection payload. Bump only
#: with a migration note here and in the gates that pin it.
CONTRACT_VERSION = "fp1"

#: The discriminant. Present, and equal to this, or the payload is not a
#: projection and this namespace will not touch it.
KIND = "projection"

#: The ``schema`` stamps the projection ENGINE puts on its OWN output.
#:
#: fp1 is what this namespace SERVES. It is not what the producer EMITS:
#: ``engine.forecast.Projection.as_dict()`` stamps ``schema:
#: "forecast_v1"`` and carries none of fp1's markers — no ``kind``, no
#: ``projected``, bare floats. That mismatch is not hypothetical; it was
#: measured, and for the whole of wave 1 it meant the F2 leak guard could
#: not see a real projection at all (a 16-period agras roll-forward
#: pasted into a served envelope produced ZERO leak paths).
#:
#: So the guard reads BOTH vocabularies, and this is where the producer's
#: half is named — once, so ``boundary.py`` and ``adapter.py`` cannot
#: disagree about it. Keyed on the VALUE, never on the key ``schema``
#: alone: the canonical balance sheet stamps ``schema: "bs_v2"`` on an
#: ACTUALS payload, and a guard keyed on the key name would red on every
#: committed book.
PRODUCER_SCHEMAS = ("forecast_v1",)

#: The keys under which a projection may name the ACTUAL book it stands
#: on. Everything beneath one of these is exempt from the source-cell ban
#: (:func:`~engine.forecast_serving.boundary.actual_provenance_on_projection`)
#: because a projection as a whole DOES stand on one book and the reader
#: has to be able to see which.
#:
#: ``base_period`` is fp1's name for it. ``opening`` is the producer's:
#: ``Projection.as_dict()["opening"]`` carries ``snapshot_id`` — the same
#: pointer, under a different word. Measured: with only ``base_period``
#: on this list, ``assert_no_actual_provenance`` RAISED on every real
#: projection this engine has ever produced, on ``$.opening.snapshot_id``
#: — a gate reddening on correct code, which TC-11 says is the gate being
#: wrong and not the product.
BASE_PERIOD_KEYS = ("base_period", "opening")

#: The units an assumption may be stated in. A driver whose unit is not
#: one of these cannot be rendered honestly beside its figure, so it is
#: refused rather than guessed at.
UNITS = ("pct", "days", "ratio", "money_minor", "count", "months")

#: Top-level keys that mean "this object carries ACTUAL figures". A
#: projection payload carrying any of them is refused: one object that
#: both gateways accept is the confusion, not the convenience.
ACTUAL_FIGURE_CONTAINERS = (
    "canonical_bs",
    "assembled_bs",
    "assembled_pl",
    "assembled_cf",
    "line_items",
    "statements",
    "methodology",
)

#: Provenance fields that belong to an ACTUAL figure — they name a cell
#: in a source document. A projected figure carrying one of these is the
#: LACKS_SHOWS bucket of design_review/PROVENANCE_CENSUS.json: an
#: affordance over a payload with nothing behind it. Refused at the
#: boundary, never rendered.
ACTUAL_PROVENANCE_FIELDS = (
    "snapshot_id",
    "line_id",
    "source_cell",
    "source_document_id",
    "content_hash",
    "sheet",
    "cell",
    "row_index",
)

# ── refusal clauses, named so a message can quote one ────────────────

CLAUSE_KIND = "kind_not_projection"
CLAUSE_CONTRACT = "contract_version_unknown"
CLAUSE_CURRENCY = "currency_missing"
CLAUSE_HORIZON = "horizon_missing_or_empty"
CLAUSE_BASE_PERIOD = "base_period_missing"
CLAUSE_NO_ACTUAL_CONTAINERS = "actual_figure_container_in_projection"
CLAUSE_ASSUMPTION_ID = "assumption_without_id"
CLAUSE_ASSUMPTION_UNIT = "assumption_unit_unknown"
CLAUSE_ASSUMPTION_BASIS = "assumption_without_stated_basis"
CLAUSE_ASSUMPTION_DUPLICATE = "assumption_id_declared_twice"
CLAUSE_ASSUMPTION_VALUES = "assumption_values_not_a_schedule"
CLAUSE_ASSUMPTION_VALUE_TYPE = "assumption_value_neither_number_nor_absent"
CLAUSE_FIGURE_LINE = "figure_without_line"
CLAUSE_FIGURE_PERIOD = "figure_period_outside_horizon"
CLAUSE_FIGURE_AMOUNT = "figure_amount_not_integer_minor"
CLAUSE_FIGURE_ASSUMPTIONS = "figure_names_no_assumption"
CLAUSE_FIGURE_UNKNOWN_ASSUMPTION = "figure_names_unknown_assumption"
CLAUSE_FIGURE_ACTUAL_PROVENANCE = "figure_carries_actual_provenance"
CLAUSE_FIGURE_DUPLICATE = "figure_declared_twice"


class ProjectionContractError(ValueError):
    """A payload that claims to be a projection and is not a valid one.

    Raised, not returned: an unreadable projection is a producer defect,
    and serving half of it would put unattributed numerals in front of a
    reader. The message names every broken clause.
    """

    def __init__(self, violations: List[Tuple[str, str]]) -> None:
        self.violations = tuple(violations)
        detail = "; ".join("%s: %s" % (code, why) for code, why in violations)
        super(ProjectionContractError, self).__init__(
            "fp1 contract broken — %s" % detail
        )


def _is_readable_driver_value(value: Any) -> bool:
    """A driver value a reader can be shown, or an explicit ABSENT.

    ``None`` is ALLOWED and is the whole point of this function. A driver
    the model could not derive for a period says so with ``None``, and
    that is a different fact from "the driver is 0". Measured: on the
    committed ``realestate`` book, ``engine.forecast`` emits 32 ``None``
    entries across ``dio_days`` and ``dpo_days`` — refusing null here
    would red this gate on correct output.

    What is NOT allowed is a value that is neither: a string, a bool, a
    NaN, an infinity. Each of those is a producer defect that the read
    side quietly turns into ABSENT (``assumption_from_raw`` ignores
    anything non-numeric), so "we could not derive it" and "we emitted
    the wrong type" become indistinguishable — and the next consumer to
    coerce that absent to 0 is the next absent-as-zero defect.
    """
    if value is None:
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        # NaN != NaN, and +/-inf is not a number a surface can paint.
        return value == value and value not in (float("inf"), float("-inf"))
    return False


def _is_int_minor(value: Any) -> bool:
    """Integer minor units. A float is refused even when it is whole: a
    payload that carries 12.0 has done float arithmetic somewhere, and
    the projected balance sheet has to close to the cent."""
    return isinstance(value, int) and not isinstance(value, bool)


def _carries_actual_provenance(obj: Any) -> Optional[str]:
    """The first ACTUAL-provenance field found anywhere inside ``obj``,
    or None. Recursive, because the field that matters is as likely to be
    nested one level down (``{"provenance": {"line_id": ...}}``) as at the
    top."""
    if isinstance(obj, dict):
        for key in obj:
            if str(key) in ACTUAL_PROVENANCE_FIELDS:
                return str(key)
        for value in obj.values():
            found = _carries_actual_provenance(value)
            if found is not None:
                return found
        return None
    if isinstance(obj, (list, tuple)):
        for item in obj:
            found = _carries_actual_provenance(item)
            if found is not None:
                return found
    return None


def clause_violations(payload: Any) -> List[Tuple[str, str]]:
    """Every broken clause, in a stable order, as ``(code, why)`` pairs.

    Returns a list rather than raising so the gates can assert on exactly
    which clause fired. The gateway raises; this function reports.
    """
    out = []  # type: List[Tuple[str, str]]
    if not isinstance(payload, dict):
        return [(CLAUSE_KIND, "payload is %s, not an object"
                 % type(payload).__name__)]

    if payload.get("kind") != KIND:
        out.append((CLAUSE_KIND,
                    "kind is %r, expected %r" % (payload.get("kind"), KIND)))
    if payload.get("contract") != CONTRACT_VERSION:
        out.append((CLAUSE_CONTRACT,
                    "contract is %r, this reader speaks %r"
                    % (payload.get("contract"), CONTRACT_VERSION)))

    for container in ACTUAL_FIGURE_CONTAINERS:
        if container in payload:
            out.append((CLAUSE_NO_ACTUAL_CONTAINERS,
                        "%r is an actual-figure container and may not ride "
                        "inside a projection payload" % container))

    currency = payload.get("currency")
    if not isinstance(currency, str) or not currency.strip():
        out.append((CLAUSE_CURRENCY, "currency is %r" % (currency,)))

    base = payload.get("base_period")
    if not isinstance(base, dict) or not str(base.get("label") or "").strip():
        out.append((CLAUSE_BASE_PERIOD,
                    "base_period must name the actual period the "
                    "projection stands on"))

    horizon = payload.get("horizon")
    if not isinstance(horizon, (list, tuple)) or not horizon:
        out.append((CLAUSE_HORIZON, "horizon is %r" % (horizon,)))
        horizon_labels = ()  # type: Tuple[str, ...]
    else:
        horizon_labels = tuple(str(h) for h in horizon)

    # ── assumptions ──────────────────────────────────────────────────
    seen_ids = []  # type: List[str]
    raw_assumptions = payload.get("assumptions")
    assumptions = raw_assumptions if isinstance(raw_assumptions, list) else []
    for index, raw in enumerate(assumptions):
        if not isinstance(raw, dict):
            out.append((CLAUSE_ASSUMPTION_ID,
                        "assumptions[%d] is %s, not an object"
                        % (index, type(raw).__name__)))
            continue
        aid = str(raw.get("id") or "")
        if not aid:
            out.append((CLAUSE_ASSUMPTION_ID,
                        "assumptions[%d] has no id" % index))
            continue
        if aid in seen_ids:
            out.append((CLAUSE_ASSUMPTION_DUPLICATE,
                        "assumption %r declared twice" % aid))
        seen_ids.append(aid)
        if str(raw.get("unit") or "") not in UNITS:
            out.append((CLAUSE_ASSUMPTION_UNIT,
                        "assumption %r has unit %r, not one of %s"
                        % (aid, raw.get("unit"), ", ".join(UNITS))))
        if not str(raw.get("basis") or "").strip():
            out.append((CLAUSE_ASSUMPTION_BASIS,
                        "assumption %r states no basis — a driver a reader "
                        "cannot interrogate is a number with an opinion "
                        "attached" % aid))
        # The schedule. Until this clause existed the contract validated a
        # driver's id, unit and basis and never once looked at the numbers
        # it actually carries: `values: "eight percent"` passed every
        # clause, and the read side turned it into ABSENT for every year.
        values = raw.get("values")
        if not isinstance(values, dict):
            out.append((CLAUSE_ASSUMPTION_VALUES,
                        "assumption %r carries values=%r; a driver states a "
                        "schedule of period -> value, and one that does not "
                        "reads as ABSENT for every year while looking "
                        "declared" % (aid, values)))
        else:
            for period_label in sorted(str(k) for k in values):
                entry = values[period_label]
                if not _is_readable_driver_value(entry):
                    out.append((
                        CLAUSE_ASSUMPTION_VALUE_TYPE,
                        "assumption %r states %r for %r; a driver value is a "
                        "number, or null for a period the model could not "
                        "derive. Anything else is read as ABSENT, which "
                        "makes 'not derived' and 'emitted wrong' the same "
                        "fact to every consumer downstream"
                        % (aid, entry, period_label)))

    # ── figures ──────────────────────────────────────────────────────
    seen_figures = []  # type: List[Tuple[str, str]]
    raw_figures = payload.get("figures")
    figures = raw_figures if isinstance(raw_figures, list) else []
    for index, raw in enumerate(figures):
        if not isinstance(raw, dict):
            out.append((CLAUSE_FIGURE_LINE,
                        "figures[%d] is %s, not an object"
                        % (index, type(raw).__name__)))
            continue
        line = str(raw.get("line") or "")
        period = str(raw.get("period") or "")
        if not line:
            out.append((CLAUSE_FIGURE_LINE, "figures[%d] has no line" % index))
        if horizon_labels and period not in horizon_labels:
            out.append((CLAUSE_FIGURE_PERIOD,
                        "figure %r names period %r, outside the horizon %s"
                        % (line, period, ", ".join(horizon_labels))))
        if (line, period) in seen_figures:
            out.append((CLAUSE_FIGURE_DUPLICATE,
                        "figure %r/%r declared twice — one concept, one "
                        "value" % (line, period)))
        seen_figures.append((line, period))
        if not _is_int_minor(raw.get("amount_minor")):
            out.append((CLAUSE_FIGURE_AMOUNT,
                        "figure %r/%r carries amount_minor=%r; integer minor "
                        "units only" % (line, period, raw.get("amount_minor"))))
        ids = raw.get("assumption_ids")
        if not isinstance(ids, (list, tuple)) or not ids:
            out.append((CLAUSE_FIGURE_ASSUMPTIONS,
                        "figure %r/%r names no assumption — a projected "
                        "figure with nothing behind it is not served"
                        % (line, period)))
        else:
            for aid in ids:
                if str(aid) not in seen_ids:
                    out.append((CLAUSE_FIGURE_UNKNOWN_ASSUMPTION,
                                "figure %r/%r names assumption %r, which the "
                                "payload does not declare"
                                % (line, period, aid)))
        found = _carries_actual_provenance(raw)
        if found is not None:
            out.append((CLAUSE_FIGURE_ACTUAL_PROVENANCE,
                        "figure %r/%r carries %r, which names a cell in a "
                        "source document; a projection has no source cell"
                        % (line, period, found)))
    return out
