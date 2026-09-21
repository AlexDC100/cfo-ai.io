"""``/api/forecast/*`` — the driver-based projection, served.

WHAT THIS ROUTER IS FOR
=======================
`engine.forecast` builds a linked three-statement projection off ONE
persisted period. `engine.forecast_serving` serves it as ``fp1.2``
(plan/2 B6, plan_contract_v2 sections 1.2, 2 and 3): ONE handler answers
``POST /api/forecast/{period_id}/recompute`` and ``GET
/api/forecast/{period_id}?horizon=3|5``, the GET being exactly a POST of
``{"horizon": {"total_years": h, "monthly_months": 12}}``, so the two share
a body_hash. The ``fp1`` contract this router first served wrapped the
projection in a shape whose whole job is to make a projected number impossible to
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
import time
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, model_validator

logger = logging.getLogger(__name__)

__all__ = ["ALLOWED_HORIZONS", "CockpitRequestBody", "PlanRequestBody",
           "ScenarioRequestBody", "build_router", "cockpit"]

#: The horizons the product offers on GET. A caller asking for anything else
#: is refused by name rather than clamped: silently serving three years to
#: someone who asked for seven is the shape of defect this repo keeps
#: finding, and the number of years is on the page the reader signs.
ALLOWED_HORIZONS = (3, 5)


# ── the wire body (2.1) ───────────────────────────────────────────────────
# MODULE SCOPE, every one (CLAUDE.md 22): a Pydantic model nested in the
# router factory of a future-annotations module binds as a QUERY parameter
# and the route answers 422 to every body. test_the_post_body_binds_at_
# module_scope and the route-binding gate hold it. Decimal values are typed
# str: no float ever enters the engine (1.1).

class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HorizonBody(_Strict):
    total_years: Optional[int] = None
    monthly_months: int = 12


class OverrideBody(_Strict):
    values: List[Optional[str]]


class ShockBody(_Strict):
    id: str
    driver_key: str
    op: str
    value: str
    start_month: int = 1
    ramp_months: int = 0
    end_month: Optional[int] = None
    source: str = "user"
    group_id: Optional[str] = None


class BehaviourOverrideBody(_Strict):
    pool: str
    fixed_share: Optional[str] = None
    volume_elasticity: Optional[str] = None


class DebtRowBody(_Strict):
    year: int
    st_draw: str = "0.00"
    st_repay: str = "0.00"
    lt_draw: str = "0.00"
    lt_repay: str = "0.00"


class SpreadBody(_Strict):
    rate_pp: str
    level_pct: str
    direction: str


class PlanRequestBody(_Strict):
    """plan_contract_v2 2.1. Every field is declared from B6; a field whose
    batch has not landed must hold its default (2.9). Which fields have
    landed, and which want keys are accepted, is read from
    ``engine.forecast_serving.blocks`` at validation time, so no later batch
    edits this module to lift a refusal."""
    horizon: Optional[HorizonBody] = None
    case: str = "base"
    case_id: Optional[str] = None
    overrides: Dict[str, OverrideBody] = {}
    shocks: List[ShockBody] = []
    behaviour_overrides: List[BehaviourOverrideBody] = []
    accept_proposals: List[str] = []
    debt_schedule: List[DebtRowBody] = []
    spread: Optional[SpreadBody] = None
    compare_case_ids: List[str] = []
    tornado_metric: Optional[str] = None
    breakeven_from: str = "baseline"
    want: Optional[List[str]] = None

    @model_validator(mode="after")
    def _only_what_has_landed(self) -> "PlanRequestBody":
        from engine.forecast_serving import blocks
        fresh = PlanRequestBody.model_construct()
        for name in type(self).model_fields:
            if name in blocks.LANDED_REQUEST_FIELDS:
                continue
            if getattr(self, name) != getattr(fresh, name):
                raise _Refusal(_not_served(), name)
        for key in self.want or []:
            if key not in blocks.ACCEPTED_WANT_KEYS:
                raise _Refusal({"code": "unknown_want_key",
                                "text": "want key %r is not served; the served "
                                        "keys are %s" % (
                                            key, ", ".join(blocks.ACCEPTED_WANT_KEYS))},
                               key)
        return self

    @staticmethod
    def accepted_want_keys() -> "tuple":
        """What the gates read at run time (3.13, 11.1)."""
        from engine.forecast_serving import blocks
        return tuple(blocks.ACCEPTED_WANT_KEYS)


class ScenarioRequestBody(_Strict):
    """POST /api/forecast/{period_id}/scenario (R6). A scenario is a TEMPLATE
    the engine compiles over this book (packs/scenarios/templates.yaml) plus
    the reader's own lever overrides; the page sends no shock and no number
    of its own. ``template`` "base" is the forecast itself (gate F4)."""
    template: str = "base"
    horizon: Optional[HorizonBody] = None
    overrides: Dict[str, OverrideBody] = {}
    want: Optional[List[str]] = None

    def as_plan_body(self) -> "PlanRequestBody":
        return PlanRequestBody(horizon=self.horizon, overrides=self.overrides,
                               want=self.want)


class CockpitRequestBody(_Strict):
    """POST /api/forecast/{period_id}/cockpit (and /cockpit/export): the
    forecast cockpit (packs/forecast/cockpit.yaml). ``case_id`` is a built-in
    case (base, optimist, pesimist) or a saved one ("saved:<id>", read from
    the company's own org_prefs); ``levers`` are the sliders moved on top of
    it, lever id -> an exact decimal string, or one per plan year. The page
    sends ids and decimal strings only: the ENGINE compiles them onto its own
    drivers and computes every figure."""
    case_id: str = "base"
    levers: Dict[str, Union[str, List[str], None]] = {}


class _Refusal(ValueError):
    """Raised inside the validator; the handler answers 422 with it. Never a
    pydantic ValueError subclass message: the sentence travels as data."""

    def __init__(self, sentence: Dict[str, str], field: Optional[str]) -> None:
        ValueError.__init__(self, sentence["text"])
        self.sentence = sentence
        self.field = field


def _not_served() -> Dict[str, str]:
    from engine.forecast.levers_pack import serving_pack
    return dict(serving_pack().not_served)


def _detail(code: str, text: str, field: Optional[str] = None) -> Dict[str, Any]:
    return {"code": code, "text": text, "field": field}


def _require_jwt(authorization: Optional[str]) -> str:
    """Same pattern as `_benchmarks.py` — local, to avoid a circular import."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _wire(body: PlanRequestBody) -> Dict[str, Any]:
    """The validated fields as a plain mapping of decimal strings: the engine
    never receives the Pydantic class (1.1). An omitted total_years is filled
    from the pack here, before validation of the horizon (2.2)."""
    from engine.forecast.levers_pack import serving_pack
    pack = serving_pack()
    raw = body.model_dump()
    if raw.get("horizon") is None:
        # 2.1: required unless case_id is sent (case_id lands in B15)
        raise HTTPException(422, _detail(pack.horizon_required["code"],
                                         pack.horizon_required["text"], "horizon"))
    horizon = dict(raw["horizon"])
    if horizon.get("total_years") is None:
        horizon["total_years"] = pack.scenarios_total_years
    if not 1 <= horizon["total_years"] <= pack.max_total_years:
        raise HTTPException(422, _detail(
            pack.total_years_range["code"],
            pack.total_years_range["text"].format(max=pack.max_total_years,
                                                  got=horizon["total_years"]),
            "horizon.total_years"))
    horizon.setdefault("monthly_months", 12)
    raw["horizon"] = horizon
    if raw.get("spread") is None:
        raw["spread"] = None
    return raw


def recompute(period_id: str, body: PlanRequestBody, jwt: str,
              x_org_id: Optional[str],
              template_id: Optional[str] = None) -> Dict[str, Any]:
    """THE handler. GET, the lever recompute and the scenario POST all end
    here, and all project through ``engine.forecast.levers.project_levers``;
    nothing else projects. ``template_id`` is the scenario's template (None
    for GET and recompute, which serve no scenario block)."""
    started = time.perf_counter()
    from . import _org

    # `resolve_org` returns (user_id, org_id) — BOTH, and unpacking it
    # is not a style choice. Bound as one name it becomes the tuple,
    # `"eq.%s" % org_id` renders `eq.('uid', 'orgid')`, and PostgREST
    # is handed a filter that matches nothing. The route would answer
    # 404 to every caller and read as "no such period".
    _user_id, org_id = _org.resolve_org(jwt, x_org_id)
    from . import _forecast_history
    from .pipeline import PeriodNotFound, StatementsRebuildError
    try:
        period, prior_periods, context, history = (
            _forecast_history.load_plan_inputs(jwt, org_id, period_id))
    except PeriodNotFound:
        raise HTTPException(404, {"code": "period_not_found",
                                  "text": "No such period in this workspace.",
                                  "id": period_id})
    except StatementsRebuildError as exc:
        # contract 1.4: never a projection built with statements None, and
        # never cached.
        raise HTTPException(409, exc.sentence())

    from engine.forecast.errors import (BalanceViolation, ForecastError,
                                        PlanRequestError)
    from engine.forecast.levers import plan_request_from_body, project_levers
    from engine.forecast_serving import boundary
    from engine.forecast_serving.plan_response import (PlanResponseError,
                                                       build_response)

    try:
        request = plan_request_from_body(_wire(body))
        plan, scenario = project_levers(period, prior_periods, request, context,
                                        template_id=template_id, client_sent=True)
        from engine.forecast.levers import serving_inputs
        payload = build_response(plan, serving_inputs(plan), period, history,
                                 request.want, period_id,
                                 anchor_updated_at=history.get("anchor_updated_at"),
                                 scenario=scenario)
    except PlanRequestError as exc:
        raise HTTPException(422, _detail(exc.code, exc.text, exc.field))
    except BalanceViolation as exc:
        # 3.11: the period and the amount as data, not only inside the text
        raise HTTPException(422, {
            "code": "balance_violation", "text": str(exc),
            "period": exc.period_label, "difference_minor": exc.delta_cents,
            "run_kind": getattr(exc, "run_kind", None)})
    except ForecastError as exc:
        # The engine's own sentence, verbatim. It names the driver that
        # could not be measured and the basis that failed to measure it,
        # which is the only thing that tells the reader what to do.
        raise HTTPException(422, _detail(
            getattr(exc, "code", None) or type(exc).__name__, str(exc),
            getattr(exc, "key", None)))
    except PlanResponseError as exc:
        # A producer defect, not a book defect: the caller cannot fix it
        # and must not be told they can.
        logger.error("[forecast] fp1.2 contract refused period %s: %s",
                     period_id, exc)
        raise HTTPException(
            500, "The projection did not satisfy its own serving "
                 "contract, so it was not served.")

    # Belt and braces, on the bytes that actually leave.
    boundary.assert_no_actual_provenance(payload)
    # OUTSIDE body_hash (1.2); the only clock the forecast lane reads.
    payload["recompute_ms"] = int((time.perf_counter() - started) * 1000)
    return payload


def _saved_case(jwt: str, org_id: str, case_id: str) -> Any:
    """(name, levers) of a saved case, read from the RESOLVED company's own
    prefs row through the caller's client (RLS is_member_of, plus the org
    filter): a case saved on another company is never found here."""
    from engine.forecast.cockpit import CockpitError, cockpit_pack, saved_case_levers
    from . import _supabase
    pack = cockpit_pack()
    with _supabase.per_user(jwt) as client:
        rows = client.select("org_prefs", filters={"org_id": "eq.%s" % org_id},
                             columns="org_id,prefs", single=True) or []
    bag = rows[0].get("prefs") if rows and rows[0].get("org_id") == org_id else None
    try:
        return saved_case_levers(bag, case_id, org_id, pack)
    except CockpitError as exc:
        raise HTTPException(exc.status, _detail(exc.code, exc.text, exc.field))


def cockpit(period_id: str, body: CockpitRequestBody, jwt: str,
            x_org_id: Optional[str]) -> Dict[str, Any]:
    """THE cockpit handler: the same loader, membership resolution and
    ``project_levers`` as :func:`recompute`, read into four numbers, one
    chart, the sentence, the levers with their bases, the cases, the bridge
    from base and the annual statements (engine.forecast.cockpit). Read-only
    compute: it writes no table."""
    started = time.perf_counter()
    from . import _org
    _user_id, org_id = _org.resolve_org(jwt, x_org_id)
    from . import _forecast_history
    from .pipeline import PeriodNotFound, StatementsRebuildError
    try:
        period, prior_periods, context, _history = (
            _forecast_history.load_plan_inputs(jwt, org_id, period_id))
    except PeriodNotFound:
        raise HTTPException(404, {"code": "period_not_found",
                                  "text": "No such period in this workspace.",
                                  "id": period_id})
    except StatementsRebuildError as exc:
        raise HTTPException(409, exc.sentence())

    from engine.forecast.cockpit import (BridgeError, CockpitError, build_cockpit,
                                         cockpit_pack)
    from engine.forecast.errors import BalanceViolation, ForecastError, PlanRequestError
    from engine.forecast_serving import boundary

    saved = None
    prefix = str(cockpit_pack().saved.get("id_prefix") or "saved:")
    if body.case_id.startswith(prefix):
        saved = _saved_case(jwt, org_id, body.case_id)
    try:
        payload = build_cockpit(period, prior_periods, context, case_id=body.case_id,
                                levers=body.levers, saved=saved)
    except CockpitError as exc:
        raise HTTPException(exc.status, _detail(exc.code, exc.text, exc.field))
    except PlanRequestError as exc:
        raise HTTPException(422, _detail(exc.code, exc.text, exc.field))
    except BalanceViolation as exc:
        raise HTTPException(422, {
            "code": "balance_violation", "text": str(exc),
            "period": exc.period_label, "difference_minor": exc.delta_cents,
            "run_kind": getattr(exc, "run_kind", None)})
    except ForecastError as exc:
        raise HTTPException(422, _detail(
            getattr(exc, "code", None) or type(exc).__name__, str(exc),
            getattr(exc, "key", None)))
    except BridgeError as exc:
        logger.error("[forecast] cockpit bridge refused period %s: %s", period_id, exc)
        raise HTTPException(
            500, "The cockpit's bridge from base did not sum to the change in "
                 "cash, so it was not served.")
    payload["period_id"] = period_id
    boundary.assert_no_actual_provenance(payload)
    # OUTSIDE pins.body_hash, like fp1.2's recompute_ms.
    payload["recompute_ms"] = int((time.perf_counter() - started) * 1000)
    return payload


def _validated_cockpit(raw: Dict[str, Any]) -> CockpitRequestBody:
    from pydantic import ValidationError
    try:
        return CockpitRequestBody.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        field = ".".join(str(p) for p in first.get("loc") or ())
        raise HTTPException(422, _detail(
            "invalid_request", "%s: %s" % (field or "body", first.get("msg")), field))


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/forecast", tags=["forecast"])

    # Registered BEFORE "/{period_id}": two path segments, so it can never be
    # read as a period id, and the order states it anyway.
    @router.get("/templates/scenarios")
    def scenario_templates(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """The scenario templates this engine serves (packs/scenarios/
        templates.yaml): each id with its declared shocks and the display
        value the page prints. Pack data only — no figure of any book."""
        _require_jwt(authorization)
        from engine.forecast.scenario_templates import catalogue
        return catalogue()

    @router.get("/{period_id}")
    def forecast_for_period(
        period_id: str,
        horizon: int = Query(5, description="Projection length in years."),
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Exactly a POST of {"horizon": {"total_years": h, "monthly_months":
        12}} (1.2). Every figure in the response is PROJECTED."""
        jwt = _require_jwt(authorization)
        if horizon not in ALLOWED_HORIZONS:
            raise HTTPException(
                422,
                "This engine projects %s years. It was asked for %d, and it "
                "will not quietly serve a different length than the one the "
                "reader asked for."
                % (" or ".join(str(h) for h in ALLOWED_HORIZONS), horizon))
        body = PlanRequestBody(horizon=HorizonBody(total_years=horizon,
                                                   monthly_months=12))
        return recompute(period_id, body, jwt, x_org_id)

    @router.post("/{period_id}/recompute")
    def forecast_recompute(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """One plan over one persisted period (1.2). Read-only compute: it
        projects a period the caller's membership reads and writes no table."""
        jwt = _require_jwt(authorization)
        return recompute(period_id, _validated(body), jwt, x_org_id)

    @router.post("/{period_id}/scenario")
    def forecast_scenario(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """One scenario over one persisted period (R6): the template the
        engine compiles over this book plus the reader's lever overrides,
        through ``project_levers``. Read-only compute: it writes no table.
        The response is the fp1.2 body with a ``scenario`` block naming the
        template and the exact shocks it compiled to."""
        jwt = _require_jwt(authorization)
        scenario = _validated_scenario(body)
        return recompute(period_id, _validated(scenario.as_plan_body().model_dump(
            exclude_defaults=True)), jwt, x_org_id, template_id=scenario.template)

    @router.post("/{period_id}/cockpit")
    def forecast_cockpit(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """The forecast cockpit over one persisted period: four numbers, one
        chart, the sentence, every lever with its basis, the cases, the
        bridge from base and the annual statements — every figure the
        engine's. Read-only compute: it writes no table."""
        jwt = _require_jwt(authorization)
        return cockpit(period_id, _validated_cockpit(body), jwt, x_org_id)

    @router.post("/{period_id}/cockpit/export")
    def forecast_cockpit_export(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """The bank export's DATA: the same cockpit payload plus the
        assumptions page, for the CFO-Report PDF pipeline (the page renders
        it in the report's print style and posts the HTML to
        /api/report/pdf). Read-only compute: it writes no table."""
        jwt = _require_jwt(authorization)
        from engine.forecast.cockpit import export_document
        return export_document(cockpit(period_id, _validated_cockpit(body), jwt, x_org_id))

    return router


def _validated_scenario(raw: Dict[str, Any]) -> ScenarioRequestBody:
    """The scenario wire body, every refusal as 422 {code, text, field}."""
    from pydantic import ValidationError
    try:
        return ScenarioRequestBody.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        field = ".".join(str(p) for p in first.get("loc") or ())
        raise HTTPException(422, _detail(
            "invalid_request", "%s: %s" % (field or "body", first.get("msg")), field))


def _validated(raw: Dict[str, Any]) -> PlanRequestBody:
    """The wire body to PlanRequestBody, every refusal as 422 {code, text,
    field}. The route takes the raw JSON object so an unknown field, a float
    where a decimal string belongs and a field whose batch has not landed all
    answer in ONE shape (3.11), not pydantic's."""
    from pydantic import ValidationError
    try:
        return PlanRequestBody.model_validate(raw)
    except _Refusal as exc:
        raise HTTPException(422, _detail(exc.sentence["code"], exc.sentence["text"],
                                         exc.field))
    except ValidationError as exc:
        first = exc.errors()[0]
        cause = (first.get("ctx") or {}).get("error")
        if isinstance(cause, _Refusal):
            raise HTTPException(422, _detail(cause.sentence["code"],
                                             cause.sentence["text"], cause.field))
        field = ".".join(str(p) for p in first.get("loc") or ())
        raise HTTPException(422, _detail(
            "invalid_request", "%s: %s" % (field or "body", first.get("msg")), field))
