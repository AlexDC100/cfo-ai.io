"""``/api/forecast/*`` — the driver-based projection, served.

WHAT THIS ROUTER IS FOR
=======================
`engine.forecast` builds a linked three-statement projection off ONE
persisted period. `engine.forecast_serving` wraps it in the ``fp1``
contract, whose whole job is to make a projected number impossible to
mistake for an actual. Between them they had, until this module, no
caller: the forecast shipped complete and unreachable, which the owner
found the only way an unreachable feature is ever found — by looking for
it in the product and not seeing it.

THE ONE THING THIS ROUTER MUST NOT DO
=====================================
Serve a projection through any shape a consumer could read as actuals.
So the payload this returns is `ProjectionGateway.as_dict()` and nothing
else: every figure inside carries ``projected: true``, the contract
version is stamped on the envelope, and the frontend reads it through
`lib/forecastFacts.ts`, whose `ProjectedMinor` type makes
`actualTotal + figure.amountMinor` a compile error.

Two guards run before the bytes leave, both from
`forecast_serving.boundary`:

  · `assert_no_actual_provenance` — no projected figure may carry an
    atom id, a source cell, a snapshot pointer or any other field that
    says "this came out of the book". The projection AS A WHOLE names
    the book it stands on, at `base_period.snapshot_id`; no single
    projected number does, because no single projected number came out
    of a cell.
  · the gateway's own `contract.clause_violations`, which refuses a
    payload whose figures name no assumptions. A figure with no
    attribution is a number with no reason, and this lane would rather
    serve nothing than that.

REFUSALS ARE THE PRODUCT, NOT AN ERROR PATH
===========================================
A book that cannot support a projection gets a 422 whose detail is the
engine's own sentence — "this period carries no served balance sheet, so
there is nothing to open the projection on", or the driver that could not
be measured and the basis that failed to measure it. That text is written
for the reader and goes to them verbatim. It is never replaced with a
generic message, and the horizon is never shortened to make a refusal go
away.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Query

logger = logging.getLogger(__name__)

__all__ = ["build_router"]

#: The horizons the product offers. A caller asking for anything else is
#: refused by name rather than clamped: silently serving three years to
#: someone who asked for seven is the shape of defect this repo keeps
#: finding, and the number of years is on the page the reader signs.
ALLOWED_HORIZONS = (3, 5)


def _require_jwt(authorization: Optional[str]) -> str:
    """Same pattern as `_benchmarks.py` — local, to avoid a circular import."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/forecast", tags=["forecast"])

    @router.get("/{period_id}")
    def forecast_for_period(
        period_id: str,
        horizon: int = Query(5, description="Projection length in years."),
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """One fp1 projection over one persisted period.

        Every figure in the response is PROJECTED. Nothing in it resolves
        to a cell in the uploaded book, and the contract makes that
        machine-checkable rather than a matter of reading the route name.
        """
        jwt = _require_jwt(authorization)
        from . import _org

        if horizon not in ALLOWED_HORIZONS:
            raise HTTPException(
                422,
                "This engine projects %s years. It was asked for %d, and it "
                "will not quietly serve a different length than the one the "
                "reader asked for."
                % (" or ".join(str(h) for h in ALLOWED_HORIZONS), horizon))

        # `resolve_org` returns (user_id, org_id) — BOTH, and unpacking it
        # is not a style choice. Bound as one name it becomes the tuple,
        # `"eq.%s" % org_id` renders `eq.('uid', 'orgid')`, and PostgREST
        # is handed a filter that matches nothing. The route would answer
        # 404 to every caller and read as "no such period".
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        from . import _forecast_history
        from .pipeline import PeriodNotFound, StatementsRebuildError
        try:
            period, prior_periods, context, _history = (
                _forecast_history.load_plan_inputs(jwt, org_id, period_id))
        except PeriodNotFound:
            raise HTTPException(404, "No such period in this workspace.")
        except StatementsRebuildError as exc:
            # plan/2 B5 (contract 1.4): never a projection built with
            # statements None, and never cached.
            raise HTTPException(409, exc.sentence())

        from engine.forecast.errors import ForecastError
        from engine.forecast.levers import PlanRequest, project_plan
        from engine.forecast_serving import boundary, contract
        from engine.forecast_serving.adapter import fp1_from_forecast_v1
        from engine.forecast_serving.gateway import ProjectionGateway

        try:
            # GET keeps fp1 and today's 422 on a book whose base plan draws
            # a funding line it cannot price (6.5): a truncated projection
            # is never served through fp1. The partial serve arrives with
            # fp1.2 in B6.
            projection = project_plan(
                period, prior_periods,
                PlanRequest(total_years=horizon, monthly_months=12), context,
                stop_at_unpriced_draw=False).projection
        except ForecastError as exc:
            # The engine's own sentence, verbatim. It names the driver
            # that could not be measured and the basis that failed to
            # measure it, which is the only thing that tells the reader
            # what to do about it.
            raise HTTPException(422, str(exc))

        try:
            gateway = ProjectionGateway(
                fp1_from_forecast_v1(projection.as_dict()))
        except contract.ProjectionContractError as exc:
            # A producer defect, not a book defect: the caller cannot fix
            # it and must not be told they can.
            logger.error("[forecast] contract refused period %s: %s",
                         period_id, exc)
            raise HTTPException(
                500, "The projection did not satisfy its own serving "
                     "contract, so it was not served.")

        payload = gateway.as_dict()
        # Belt and braces, on the bytes that actually leave.
        boundary.assert_no_actual_provenance(payload)

        payload["period_id"] = period_id
        payload["company_name"] = period.get("company_name")
        payload["notes"] = list(projection.notes)
        return payload

    return router
