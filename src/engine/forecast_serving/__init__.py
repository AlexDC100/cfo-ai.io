"""forecast_serving - THE NAMESPACE BOUNDARY BETWEEN FACT AND ASSUMPTION.

Every number this product has served so far is a FACT anchored to a
source cell. A forecast is an ASSUMPTION. The engine's credibility
depends on the reader never confusing the two, and a reader can only
avoid confusing them if the SOFTWARE cannot confuse them first.

That is what this package is. It is not a formatter and it is not a
styling convention: it is a second, structurally separate serving
namespace, so that

    engine.serving.facts.FactsGateway   ->  Fact              (actuals)
    engine.forecast_serving.ProjectionGateway -> ProjectedFigure

are two types that no consumer can hold interchangeably. Ask a
:class:`~engine.forecast_serving.projection.ProjectedFigure` for
``.amount_minor``, ``.to_float()`` or ``.provenance`` - the three
accessors every actuals consumer in this repo reaches for - and it
raises :class:`~engine.forecast_serving.projection.ProjectedFigureMisuse`
naming what you asked for and what to ask instead.

WHAT IS HERE
------------
  ``contract``    the fp1 wire shape, its clauses and its refusal codes
  ``projection``  ProjectedFigure / AssumptionRef / ProjectionRefusal
  ``gateway``     ProjectionGateway - the only reader of a projection
  ``boundary``    the three guards: F2 (no projection in actuals),
                  F4 (no source cell on a projection), F5 (no
                  AI-authored numeral)
  ``adapter``     forecast_v1 (what the producer EMITS) -> fp1 (what this
                  namespace SERVES). Reads a DICT, so the boundary still
                  imports nothing from the producer.

WHAT IS DELIBERATELY NOT HERE
------------------------------
The projection itself. This package does no forecasting: it computes no
growth rate, fits no driver, and rolls no balance sheet forward. It
imports neither ``engine.forecast`` nor ``engine.forecast_drivers``, and
they do not import it. A boundary that lives inside the thing it bounds
is not a boundary.

Also not here: any model. Importing this package loads no AI surface at
all, which ``boundary.assert_no_model_surface_imported`` proves rather
than asserts. The one AI touchpoint,
:func:`~engine.forecast_serving.boundary.guard_projection_narrative`,
imports ``engine.ai.numerals`` inside the function body and refuses any
draft containing a numeral the engine did not author.

Python 3.9. No I/O, no network, no clock, no ``hash()``.
"""

from __future__ import annotations

from .adapter import (
    ATTRIBUTION_KEY,
    ForecastAdapterError,
    exact_minor,
    fp1_from_forecast_v1,
    is_forecast_v1,
)
from .boundary import (
    MODEL_SURFACE_MODULES,
    BoundaryViolation,
    actual_provenance_on_projection,
    ai_authored_numerals,
    assert_no_actual_provenance,
    assert_no_model_surface_imported,
    assert_no_projection_in_actuals,
    guard_projection_narrative,
    projection_leaks_into_actuals,
)
from .contract import (
    ACTUAL_FIGURE_CONTAINERS,
    ACTUAL_PROVENANCE_FIELDS,
    BASE_PERIOD_KEYS,
    CONTRACT_VERSION,
    KIND,
    PRODUCER_SCHEMAS,
    UNITS,
    ProjectionContractError,
    clause_violations,
)
from .gateway import ProjectionGateway
from .projection import (
    PROJECTED_MARKER,
    AssumptionRef,
    ProjectedFigure,
    ProjectedFigureMisuse,
    ProjectionRefusal,
)

__all__ = [
    # contract
    "CONTRACT_VERSION",
    "KIND",
    "UNITS",
    "ACTUAL_FIGURE_CONTAINERS",
    "ACTUAL_PROVENANCE_FIELDS",
    "BASE_PERIOD_KEYS",
    "PRODUCER_SCHEMAS",
    "ProjectionContractError",
    "clause_violations",
    # adapter (forecast_v1 -> fp1)
    "ATTRIBUTION_KEY",
    "ForecastAdapterError",
    "exact_minor",
    "fp1_from_forecast_v1",
    "is_forecast_v1",
    # types
    "PROJECTED_MARKER",
    "AssumptionRef",
    "ProjectedFigure",
    "ProjectedFigureMisuse",
    "ProjectionRefusal",
    # gateway
    "ProjectionGateway",
    # boundary
    "BoundaryViolation",
    "projection_leaks_into_actuals",
    "assert_no_projection_in_actuals",
    "actual_provenance_on_projection",
    "assert_no_actual_provenance",
    "ai_authored_numerals",
    "guard_projection_narrative",
    "assert_no_model_surface_imported",
    "MODEL_SURFACE_MODULES",
]
