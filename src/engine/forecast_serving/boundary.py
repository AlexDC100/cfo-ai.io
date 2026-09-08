"""THE BOUNDARY GUARDS - what may cross between actuals and projections.

Three directions, three guards. Each one is a function that REPORTS
violations, plus an ``assert_`` wrapper that raises. The gates assert on
the reports; product code calls the wrappers.

  1. :func:`projection_leaks_into_actuals` - F2.
     A projected figure sitting inside an ACTUALS payload. This is the
     defect that ends with a reader treating a projection as a measured
     fact, and it is the one the owner named: "no forecast figure may
     ever be served through an accessor a consumer could mistake for an
     actual".

  2. :func:`actual_provenance_on_projection` - F4.
     A projected figure carrying a source-cell affordance
     (``snapshot_id`` / ``line_id`` / ``source_cell`` ...). That is the
     LACKS_SHOWS bucket of ``design_review/PROVENANCE_CENSUS.json``
     exactly: an affordance over a payload with nothing behind it. The
     census gate already says that bucket is never an acceptable steady
     state; this makes the projection side of it impossible rather than
     merely discouraged.

  3. :func:`ai_authored_numerals` / :func:`guard_projection_narrative`
     - F5. No model-authored numeral may reach a driver or a projected
     result. This does NOT install a second guard: ``engine.ai.numerals``
     already refuses model-authored digits against typed facts with a
     deterministic fallback, and this module calls it in
     ``MODE_ENFORCE``, reading ``GuardResult.accepted`` itself and
     substituting the fallback rather than serving ``result.text``. That
     is what makes ``AI_NUMERAL_GUARD=off`` unable to disarm this
     channel - the same construction ``engine.insights.narrative`` uses,
     for the same reason it uses it.

WHY THE GUARDS ARE HERE AND NOT IN THE PRODUCER
------------------------------------------------
Because the producer is the thing being guarded. ``engine.forecast``
(the projection engine) and ``engine.forecast_drivers`` are written by
other hands and will be rewritten; a check that lives inside the code it
checks disappears with the next refactor of that code. This module
imports neither of them.

Python 3.9. No I/O, no network. The ONLY import outside the standard
library is ``engine.ai.numerals``, and it is deferred into the function
that uses it so that importing this package pulls in no model surface at
all - which :func:`assert_no_model_surface_imported` then proves.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .contract import (
    ACTUAL_PROVENANCE_FIELDS,
    BASE_PERIOD_KEYS,
    KIND,
    PRODUCER_SCHEMAS,
)
from .projection import PROJECTED_MARKER

__all__ = [
    "BoundaryViolation",
    "projection_leaks_into_actuals",
    "assert_no_projection_in_actuals",
    "actual_provenance_on_projection",
    "assert_no_actual_provenance",
    "guard_projection_narrative",
    "assert_no_model_surface_imported",
    "MODEL_SURFACE_MODULES",
]


class BoundaryViolation(AssertionError):
    """A projected figure and an actual figure got into the same place.

    An ``AssertionError`` because it is an invariant break, not a bad
    input: by the time this raises, some code has already built an object
    that would mislead a reader.
    """


def _paths_with(node: Any, predicate, path: str = "$") -> List[Tuple[str, Any]]:
    """Every ``(json_path, node)`` in ``node`` for which ``predicate``
    holds. Depth-first, in declared order - deterministic output."""
    out = []  # type: List[Tuple[str, Any]]
    if predicate(node):
        out.append((path, node))
    if isinstance(node, dict):
        for key in node:
            out.extend(_paths_with(node[key], predicate, "%s.%s" % (path, key)))
    elif isinstance(node, (list, tuple)):
        for index, item in enumerate(node):
            out.extend(_paths_with(item, predicate, "%s[%d]" % (path, index)))
    return out


def _is_projection_node(node: Any) -> bool:
    """Is this dict a projection, in ANY of the shapes one exists in?

    THREE VOCABULARIES, AND THE GATE HAS TO READ ALL THREE
    -----------------------------------------------------
    1. fp1, what this namespace SERVES: ``kind == "projection"`` and
       ``projected: True`` on every figure.
    2. fp1 with the marker stripped: a figure that still names its
       assumptions and its amount. A serializer that drops the marker is
       the failure mode this exists to catch, and a projection that
       arrives here having LOST its marker is more dangerous than one
       that kept it, not less.
    3. ``forecast_v1``, what the projection ENGINE actually emits.
       ``engine.forecast.Projection.as_dict()`` carries no ``kind``, no
       ``projected``, no ``assumption_ids`` and no minor units — a
       ``schema`` stamp and bare floats.

    (3) is the one this gate was blind to for the whole of wave 1, and it
    is the shape a pipeline would really paste into a served envelope.
    MEASURED before the repair: a real 16-period agras roll-forward
    dropped into a real served envelope gave
    ``projection_leaks_into_actuals -> 0 paths`` and
    ``assert_no_projection_in_actuals -> PASSED``. Everything the wave-1
    suite called "the real projection" reached this function through a
    TEST-ONLY adapter that had already reshaped it into (1), so the gate
    was measured against a mirror of itself. That is this repo's
    documented failure mode, in writing, twice.

    Keyed on the schema's VALUE and never on the key ``schema`` alone:
    the canonical balance sheet stamps ``schema: "bs_v2"`` on an ACTUALS
    payload, so a guard keyed on the key name would red on every
    committed book.
    """
    if not isinstance(node, dict):
        return False
    if node.get("kind") == KIND:
        return True
    if node.get(PROJECTED_MARKER) is True:
        return True
    if node.get("schema") in PRODUCER_SCHEMAS:
        return True
    # A figure that names assumptions and an amount is a projection even
    # if somebody stripped the marker off it on the way through - which
    # is exactly what a careless serializer does.
    if "amount_minor_projected" in node:
        return True
    if "assumption_ids" in node and "amount_minor" in node:
        return True
    return False


# -- 1. F2: a projection inside the actuals namespace -------------------


def projection_leaks_into_actuals(actuals: Any) -> List[str]:
    """Every path inside an ACTUALS payload that carries a projection.

    Returns paths, not booleans, because the caller has to be able to say
    WHERE - a guard that reports "somewhere in this 4MB envelope" is a
    guard nobody can act on.

    What it recognises as a projection is deliberately WIDER than the
    marker alone (see :func:`_is_projection_node`): the marker is the
    contract, and a serializer that drops it is the failure mode this
    exists to catch. A projected figure that arrives here having lost its
    marker is MORE dangerous than one that kept it, not less.
    """
    return [path for path, _ in _paths_with(actuals, _is_projection_node)]


def assert_no_projection_in_actuals(actuals: Any) -> None:
    """Raise :class:`BoundaryViolation` if a projection reached actuals."""
    leaks = projection_leaks_into_actuals(actuals)
    if leaks:
        raise BoundaryViolation(
            "a projected figure is sitting inside an ACTUALS payload at %s. "
            "Every figure an actuals accessor serves resolves to a cell in "
            "the uploaded book; this one resolves to an assumption. Serve it "
            "through engine.forecast_serving.ProjectionGateway instead."
            % ", ".join(leaks[:5])
        )


# -- 2. F4: a source cell on a projection -------------------------------


def actual_provenance_on_projection(projection: Any) -> List[str]:
    """Every path inside a PROJECTION payload carrying a source-cell
    affordance.

    The base-book pointer is EXEMPT and is the only exemption: the
    projection as a whole stands on one actual book and the reader has to
    be able to see which. What is forbidden is a source cell on a
    FIGURE - the claim that this projected number came out of that cell,
    which is false for every projected number that has ever existed.

    The exemption is keyed on :data:`contract.BASE_PERIOD_KEYS`, not on
    the literal word ``base_period``, because the two producers name the
    same pointer differently: fp1 calls it ``base_period``, and
    ``engine.forecast.Projection.as_dict()`` calls it ``opening``.
    MEASURED before that list existed: this function returned
    ``['$.opening.snapshot_id']`` and ``assert_no_actual_provenance``
    RAISED on every real projection this engine has ever produced. One
    concept, one value, across BOTH producers - the same law the figure
    names broke in the other direction.
    """
    out = []  # type: List[str]

    def _walk(node: Any, path: str, inside_base_period: bool) -> None:
        if isinstance(node, dict):
            for key in node:
                child_path = "%s.%s" % (path, key)
                is_base = inside_base_period or str(key) in BASE_PERIOD_KEYS
                if str(key) in ACTUAL_PROVENANCE_FIELDS and not is_base:
                    out.append(child_path)
                _walk(node[key], child_path, is_base)
        elif isinstance(node, (list, tuple)):
            for index, item in enumerate(node):
                _walk(item, "%s[%d]" % (path, index), inside_base_period)

    _walk(projection, "$", False)
    return out


def assert_no_actual_provenance(projection: Any) -> None:
    """Raise :class:`BoundaryViolation` if a projected figure carries a
    source cell."""
    found = actual_provenance_on_projection(projection)
    if found:
        raise BoundaryViolation(
            "a projected figure carries an ACTUAL-provenance field at %s. "
            "A projection has no source cell: it resolves to the assumptions "
            "that produced it. An affordance that offers a source jump and "
            "lands nowhere is the LACKS_SHOWS bucket of the provenance "
            "census, which that gate declares is never a state to sit in."
            % ", ".join(found[:5])
        )


# -- 3. F5: no AI-authored numeral ---------------------------------------

#: Every module that can PRODUCE model output. The forecast packages must
#: import none of them: a projected number is arithmetic over a driver, and
#: there is no step in that arithmetic a model belongs in.
#:
#: WHAT IS DELIBERATELY NOT ON THIS LIST, AND WHY (this roster was WRONG
#: on its first draft and the measurement is what corrected it):
#:
#:   ``engine.ai.registry`` — a schema-validated YAML table of
#:     {role -> model_id, prompt_version, ...}. Its own module docstring
#:     says "Stdlib + yaml ONLY ... must never pull the API package,
#:     packs runtime, or any SDK". It cannot author a digit and cannot
#:     reach the network. Listing it made this gate red on
#:     ``engine.forecast_drivers``, whose only sin is reading a book
#:     through ``engine.insights`` — and ``engine.insights.__init__``
#:     imports its narrative lane, which names the registry. That is a
#:     gate reddening on correct code, which TC-11 says is the gate being
#:     wrong, not the product.
#:
#:   ``engine.ai.numerals`` — the GUARD. It is the thing that refuses
#:     model-authored digits. Forbidding the defence would be an
#:     inversion, and ``guard_projection_narrative`` below imports it on
#:     purpose.
#:
#: The test is not "does the name contain ai". It is: CAN THIS MODULE PUT
#: A MODEL ON THE WIRE OR RETURN MODEL-AUTHORED TEXT. Verified per entry:
#: ``engine.ai_lane.config`` imports the ``anthropic`` SDK;
#: ``engine.ai.finding_sharpen`` constructs breaker-guarded clients;
#: ``engine.ai.advisory`` is the advisory model pass.
MODEL_SURFACE_MODULES = (
    "anthropic",
    "openai",
    "engine.ai.advisory",
    "engine.ai.finding_sharpen",
    "engine.ai_lane",
)


def assert_no_model_surface_imported(package_prefix: str = "engine.forecast") -> None:
    """Prove that importing the forecast packages pulled in no model.

    Reads ``sys.modules`` rather than parsing source, because the thing
    that matters is what is actually loaded: a lazily-imported client is
    still a client the moment somebody calls the function that imports
    it, and this check run after exercising the package catches that
    where a static import scan does not.
    """
    loaded = sorted(
        name for name in list(sys.modules)
        if any(name == m or name.startswith(m + ".")
               for m in MODEL_SURFACE_MODULES)
    )
    if loaded:
        raise BoundaryViolation(
            "the %s packages have a model surface loaded: %s. AI never "
            "produces a projected number - not a driver, not a result, not "
            "a rounding. If a narrative is wanted, it goes through "
            "guard_projection_narrative, which refuses digits."
            % (package_prefix, ", ".join(loaded))
        )


def guard_projection_narrative(text: Any, facts: Dict[str, Any],
                               fallback: str) -> Dict[str, Any]:
    """Run one model-drafted sentence about a projection through the
    numeral guard, in ENFORCE, and return what may actually be served.

    Returns ``{"text", "source", "reason"}`` where ``source`` is
    ``"ai"`` only when the guard ACCEPTED the draft; on any refusal the
    deterministic ``fallback`` is returned and the reason names the
    rejection code that fired.

    TWO DEFENCES, AND NEITHER ONE IS SUFFICIENT ALONE. Measured by
    planting each away in turn (transcripts in the lane report):

      * ``mode=MODE_ENFORCE`` passed explicitly. ``_guard`` resolves an
        explicit mode BEFORE consulting the environment, so no value of
        ``AI_NUMERAL_GUARD`` can reach this call. Drop the argument and
        set ``AI_NUMERAL_GUARD=off`` and the guard becomes a passthrough
        that reports ``accepted=True``: measured, the model's own
        sentence "Revenue reaches 128.1 million next year." is served.
        The mode argument is the ONLY thing that closes ``off``.
      * reading ``GuardResult.accepted`` here rather than serving
        ``result.text``. In ``observe`` the guard analyses honestly and
        passes the text through BYTE-IDENTICAL with ``accepted=False`` —
        so the mode argument alone would serve the model's numeral there.
        Reading ``accepted`` is the ONLY thing that closes ``observe``.

    Written down because the obvious summary ("reading accepted is what
    holds the line") is what this docstring said first, and it is wrong:
    it is true of ``observe`` and false of ``off``.

    ``facts`` must be the TYPED facts of ``engine.ai.numerals``
    (``MoneyFact`` / ``RatioFact`` / ``CountFact`` / ``LabelFact``). A
    projected money figure passed as a bare float is refused by the guard
    itself as an untyped fact, which is the correct answer.
    """
    # Deferred so that importing this package loads no model surface -
    # `assert_no_model_surface_imported` proves that, and an import at
    # module scope would make it a lie.
    from engine.ai.numerals import MODE_ENFORCE, guard

    result = guard(text, facts, fallback=fallback, mode=MODE_ENFORCE)
    if getattr(result, "accepted", False):
        return {"text": result.text, "source": "ai", "reason": ""}
    codes = ", ".join(
        sorted(set(r.code for r in getattr(result, "rejections", ())))
    )
    return {
        "text": fallback,
        "source": "deterministic",
        "reason": "numeral guard refused the draft (%s)" % (codes or "unknown"),
    }


def ai_authored_numerals(block: Any) -> List[str]:
    """Every path in ``block`` where a field named as model-authored also
    carries a digit.

    A blunt instrument on purpose. The refined instrument is
    :func:`guard_projection_narrative`; this is the sweep that catches a
    lane which never called it.
    """
    import re

    numeral = re.compile(r"\d")
    suspicious = ("explanation", "so_what", "narrative", "commentary",
                  "summary", "ai_text", "draft")
    out = []  # type: List[str]

    def _walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key in node:
                child = "%s.%s" % (path, key)
                value = node[key]
                if (str(key) in suspicious and isinstance(value, str)
                        and numeral.search(value)):
                    out.append(child)
                _walk(value, child)
        elif isinstance(node, (list, tuple)):
            for index, item in enumerate(node):
                _walk(item, "%s[%d]" % (path, index))

    _walk(block, "$")
    return out
