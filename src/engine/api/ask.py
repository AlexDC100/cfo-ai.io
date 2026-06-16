"""POST /api/ask — streaming SSE endpoint for the Ask CFO AI assistant.

Single source of truth for the chat surface. Builds a rich, structured
context from the caller's org + period (Phase II valuations, recommendations,
alerts, top SKUs), composes it into the mastermind system prompt, and
streams Opus 4.7 output token-by-token via Server-Sent Events.

The model can invoke tools (get_metric, compare_periods, lookup_benchmark,
list_skus, web_search, generate_report) mid-response when the loaded
context isn't enough — each tool call surfaces as a `tool_use` SSE event
and the result as `tool_result`.

SSE event shapes:
    data: {"type": "token", "text": "..."}
    data: {"type": "tool_use", "name": "...", "input": {...}, "tool_use_id": "..."}
    data: {"type": "tool_result", "name": "...", "output": {...}, "tool_use_id": "..."}
    data: {"type": "done", "usage": {"input_tokens": N, "output_tokens": M}}
    data: {"type": "error", "message": "..."}

Persistence: every assistant turn is appended to chat_messages / chat_threads
in Supabase via _supabase admin. Threads are scoped by org_id + user_id and
the caller's JWT is verified before any work begins.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import _supabase
from . import _usage_limits
from ._system_prompt import ASK_SYSTEM_PROMPT, APP_REFERENCE


logger = logging.getLogger(__name__)


# ─── Request shapes ─────────────────────────────────────────────────────────


class AskMessage(BaseModel):
    role: str = Field(..., description="'user' or 'assistant'")
    content: str


class AskContext(BaseModel):
    org_id: Optional[str] = None
    period_id: Optional[str] = None
    locale: str = "en"
    thread_id: Optional[str] = None  # round-tripped — server creates one on first turn


class AskRequest(BaseModel):
    messages: List[AskMessage]
    context: AskContext


# ─── Auth ────────────────────────────────────────────────────────────────────


def _require_jwt(authorization: Optional[str]) -> str:
    # PUBLIC_TEST_MODE bypass — see `_test_mode.py`. Open-access posture.
    from . import _test_mode
    if _test_mode.is_test_mode():
        # Mint (and cache) a real Supabase access_token for the synthetic
        # test user so per_user(jwt) downstream calls Supabase honors.
        # RLS-scoped to test org via the test user's membership row.
        try:
            return _test_mode.get_test_user_jwt()
        except Exception:  # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception(
                "[test_mode] JWT mint failed; falling back to placeholder."
            )
            return _test_mode.JWT_BYPASS_PLACEHOLDER
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


# ─── Context builder ─────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def build_ask_context(org_id: Optional[str], period_id: Optional[str]) -> Dict[str, Any]:
    """Assemble the structured context block the model uses to ground answers.

    Returns a dict that's JSON-serialized into the user-message payload. When
    org_id is missing we return a minimal stub so teacher-mode still works
    (concept explanations don't need company data).
    """
    if not org_id:
        return {
            "organization": None,
            "current_date": _today_iso(),
            "available_periods": [],
            "period": None,
        }

    with _supabase.admin() as client:
        org_rows = client.select(
            "organizations",
            filters={"id": f"eq.{org_id}"},
            single=True,
        )
        org = org_rows[0] if org_rows else None

        # Every analyzed period for the org — gives the assistant the option
        # to compare across time even when only one is active.
        period_rows = client.select(
            "financial_periods",
            filters={"org_id": f"eq.{org_id}"},
            order="period_end.desc",
            limit=10,
        )

        base = {
            "organization": (
                {
                    "id": org["id"],
                    "name": org["name"],
                    "industry_key": org.get("industry_key"),
                    "industry": org.get("industry_display_name") or org.get("industry_key"),
                    "country": org.get("country") or org.get("country_code"),
                    "currency": org.get("default_currency", "RON"),
                }
                if org
                else None
            ),
            "current_date": _today_iso(),
            "available_periods": [
                {
                    "period_id": p["id"],
                    "label": p.get("period_label") or str(p.get("period_end") or ""),
                    "period_end": str(p.get("period_end") or ""),
                    "currency": p.get("currency", "RON"),
                }
                for p in period_rows
            ],
        }

        if not period_id:
            return {**base, "period": None}

        # Find the requested period (or its newest analyzed sibling)
        period_match = next((p for p in period_rows if p["id"] == period_id), None)
        if not period_match and period_rows:
            period_match = period_rows[0]
            period_id = period_match["id"]
        if not period_match:
            return {**base, "period": None}

        metrics_rows = client.select(
            "calculated_metrics",
            filters={"period_id": f"eq.{period_id}"},
        )
        valuation_rows = client.select(
            "valuations",
            filters={"period_id": f"eq.{period_id}"},
            single=True,
        )
        valuation = valuation_rows[0] if valuation_rows else None

        briefing_rows = client.select(
            "briefings",
            filters={"period_id": f"eq.{period_id}"},
            single=True,
        )
        briefing = briefing_rows[0] if briefing_rows else None

        line_items = client.select(
            "statement_line_items",
            filters={"period_id": f"eq.{period_id}"},
        )

        recs = client.select(
            "recommendations",
            filters={"org_id": f"eq.{org_id}"},
            order="urgency.desc,created_at.desc",
            limit=10,
        )
        alerts = client.select(
            "alerts",
            filters={
                "org_id": f"eq.{org_id}",
                "resolved_at": "is.null",
            },
            order="severity.desc",
            limit=10,
        )

    period_block = {
        "period_id": period_match["id"],
        "label": period_match.get("period_label") or str(period_match.get("period_end")),
        "period_end": str(period_match.get("period_end") or ""),
        "currency": period_match.get("currency", "RON"),
        "metrics": [
            {
                "name": m["name"],
                "value": m.get("value"),
                "unit": m.get("unit"),
                "direction": m.get("direction"),
            }
            for m in metrics_rows
        ],
        "statement_line_items_top": [
            {"bucket": li.get("bucket"), "amount": li.get("amount"), "label": li.get("label")}
            for li in sorted(line_items, key=lambda r: abs(float(r.get("amount") or 0)), reverse=True)[:40]
        ],
        "valuation": _summarize_valuation(valuation),
        "briefing": (briefing or {}).get("body"),
        "recommendations": [
            {
                "title": r.get("title"),
                "explanation": r.get("explanation"),
                "urgency": r.get("urgency"),
                "expected_cash_impact_kron": r.get("expected_cash_impact_kron"),
                "status": r.get("status"),
            }
            for r in recs
        ],
        "alerts": [
            {
                "title": a.get("title"),
                "body": a.get("body"),
                "severity": a.get("severity"),
                "category": a.get("category"),
            }
            for a in alerts
        ],
    }

    return {**base, "period": period_block}


def _summarize_valuation(v: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not v:
        return None

    def f(k: str) -> Optional[float]:
        x = v.get(k)
        return None if x is None else float(x)

    return {
        "primary_method": v.get("primary_method"),
        "confidence": v.get("confidence"),
        "ebitda_used": f("ebitda_used"),
        "total_debt_used": f("total_debt_used"),
        "cash_used": f("cash_used"),
        "multiple_ebitda_p50": f("multiple_ebitda_p50"),
        "equity_ebitda_p25": f("equity_ebitda_p25"),
        "equity_ebitda_p50": f("equity_ebitda_p50"),
        "equity_ebitda_p75": f("equity_ebitda_p75"),
        "dcf_equity_value": f("dcf_equity_value"),
        "ev_revenue_equity_p50": f("ev_revenue_equity_p50"),
        "multiples_source": v.get("multiples_source"),
    }


# ─── Tools ──────────────────────────────────────────────────────────────────


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "get_metric",
        "description": (
            "Fetch a specific computed metric for a period (defaults to the active period). "
            "Use ONLY when the metric the user is asking about isn't already in the loaded "
            "<company_context.period.metrics> block."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric_name": {"type": "string"},
                "period_id": {"type": "string"},
            },
            "required": ["metric_name"],
        },
    },
    {
        "name": "compare_periods",
        "description": "Compare a single metric across multiple periods. Returns time series.",
        "input_schema": {
            "type": "object",
            "properties": {
                "metric_name": {"type": "string"},
                "period_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["metric_name", "period_ids"],
        },
    },
    {
        "name": "lookup_benchmark",
        "description": (
            "Look up industry percentile benchmarks (P25/P50/P75) for a metric. "
            "industry_key defaults to the active org's classification."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric_name": {"type": "string"},
                "industry_key": {"type": "string"},
            },
            "required": ["metric_name"],
        },
    },
    {
        "name": "list_skus",
        "description": (
            "Filter and list SKUs from the active sales dataset. Use when the user asks "
            "about specific products, brands, categories, or classification buckets."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filter": {
                    "type": "object",
                    "properties": {
                        "classification": {"type": "string"},
                        "brand": {"type": "string"},
                        "category": {"type": "string"},
                        "min_volume": {"type": "number"},
                        "max_gm_pct": {"type": "number"},
                    },
                },
                "sort": {
                    "type": "string",
                    "enum": ["profit_desc", "profit_asc", "volume_desc", "gm_pct_asc"],
                },
                "limit": {"type": "integer", "maximum": 50},
            },
        },
    },
]


# ─── Tool dispatch (server-side execution) ──────────────────────────────────


def _run_tool(name: str, tool_input: Dict[str, Any], *,
              org_id: Optional[str], default_period_id: Optional[str]) -> Dict[str, Any]:
    """Execute a tool call against Supabase and return a JSON-serializable result."""
    try:
        if name == "get_metric":
            metric_name = tool_input.get("metric_name")
            period_id = tool_input.get("period_id") or default_period_id
            if not metric_name or not period_id:
                return {"error": "missing metric_name or period_id"}
            with _supabase.admin() as client:
                rows = client.select(
                    "calculated_metrics",
                    filters={
                        "period_id": f"eq.{period_id}",
                        "name": f"eq.{metric_name}",
                    },
                    single=True,
                )
            return rows[0] if rows else {"error": "not_found", "metric_name": metric_name}

        if name == "compare_periods":
            metric_name = tool_input.get("metric_name")
            period_ids = tool_input.get("period_ids") or []
            if not metric_name or not period_ids:
                return {"error": "missing metric_name or period_ids"}
            with _supabase.admin() as client:
                rows = client.select(
                    "calculated_metrics",
                    filters={
                        "name": f"eq.{metric_name}",
                        "period_id": f"in.({','.join(period_ids)})",
                    },
                )
            return {"metric_name": metric_name, "rows": rows}

        if name == "lookup_benchmark":
            metric_name = tool_input.get("metric_name")
            industry_key = tool_input.get("industry_key")
            if not industry_key and org_id:
                with _supabase.admin() as client:
                    org_rows = client.select(
                        "organizations",
                        filters={"id": f"eq.{org_id}"},
                        single=True,
                    )
                    industry_key = (org_rows[0] if org_rows else {}).get("industry_key")
            if not metric_name or not industry_key:
                return {"error": "missing metric_name or industry_key"}
            with _supabase.admin() as client:
                rows = client.select(
                    "industry_benchmarks",
                    filters={
                        "metric_name": f"eq.{metric_name}",
                        "industry_key": f"eq.{industry_key}",
                    },
                    single=True,
                )
            return rows[0] if rows else {"error": "no_benchmark", "industry_key": industry_key}

        if name == "list_skus":
            f = tool_input.get("filter") or {}
            limit = max(1, min(int(tool_input.get("limit") or 20), 50))
            if not org_id:
                return {"error": "missing org_id"}
            with _supabase.admin() as client:
                dataset_rows = client.select(
                    "sales_datasets",
                    filters={"org_id": f"eq.{org_id}"},
                    order="created_at.desc",
                    limit=1,
                )
                if not dataset_rows:
                    return {"error": "no_sales_dataset"}
                ds_id = dataset_rows[0]["id"]
                filters: Dict[str, str] = {"dataset_id": f"eq.{ds_id}"}
                if f.get("classification"):
                    filters["classification"] = f"eq.{f['classification']}"
                if f.get("brand"):
                    filters["brand"] = f"eq.{f['brand']}"
                if f.get("category"):
                    filters["category"] = f"eq.{f['category']}"
                sort = tool_input.get("sort") or "profit_desc"
                order_map = {
                    "profit_desc": "gm_krn.desc.nullslast",
                    "profit_asc": "gm_krn.asc.nullslast",
                    "volume_desc": "volume_tons.desc.nullslast",
                    "gm_pct_asc": "gm_pct.asc.nullslast",
                }
                rows = client.select(
                    "sku_aggregates",
                    filters=filters,
                    order=order_map.get(sort, "gm_krn.desc.nullslast"),
                    limit=limit,
                )
            return {"dataset_id": ds_id, "count": len(rows), "skus": rows}
    except Exception as e:  # noqa: BLE001
        logger.exception("[ask] tool %s failed", name)
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": f"unknown_tool:{name}"}


# ─── Streaming generator ─────────────────────────────────────────────────────


def _sse(payload: Dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n".encode("utf-8")


def _stream_ask(jwt: str, req: AskRequest) -> Iterator[bytes]:
    """The actual SSE generator. Verifies the JWT, builds context, calls Opus 4.7
    in streaming mode, dispatches tool calls in a loop, and emits events.
    """
    # Validate the user (this also implicitly checks the JWT shape via Supabase)
    user_id: Optional[str] = None
    try:
        with _supabase.per_user(jwt) as client:
            user = client.get_user(jwt)
            user_id = user.get("id")
    except Exception as e:  # noqa: BLE001
        yield _sse({"type": "error", "message": f"auth_failed: {e}"})
        return

    # Phase 5 — bump the monthly LLM-call counter. Quota was already checked
    # in the route handler before the stream opened; here we record the spend.
    # Best-effort: failure is logged inside the helper, never raised.
    if user_id:
        _usage_limits.record_usage(user_id, "llm_call")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        yield _sse({
            "type": "error",
            "message": (
                "Set ANTHROPIC_API_KEY in the backend environment. The Ask CFO AI "
                "endpoint requires Opus 4.7 access."
            ),
        })
        return

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        yield _sse({"type": "error", "message": "anthropic SDK not installed."})
        return

    org_id = req.context.org_id
    period_id = req.context.period_id

    company_context = build_ask_context(org_id, period_id)
    locale = (req.context.locale or "en").lower()

    # Compose the user payload with explicit XML-style wrappers so the model
    # treats the context as data, not as another prompt to follow.
    user_payload_blocks: List[Dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "<company_context>\n"
                f"{json.dumps(company_context, ensure_ascii=False, default=str, indent=2)}\n"
                "</company_context>\n\n"
                f"<context.locale>{locale}</context.locale>\n\n"
                "<app_reference>\n"
                f"{APP_REFERENCE}\n"
                "</app_reference>"
            ),
        }
    ]

    # Build the messages array — we prepend the context as the first user
    # message, then replay the user's turns + tool results.
    incoming_messages: List[Dict[str, Any]] = [
        {"role": "user", "content": user_payload_blocks},
    ]
    for m in req.messages:
        role = m.role if m.role in ("user", "assistant") else "user"
        incoming_messages.append({"role": role, "content": m.content})

    # max_retries=5 covers transient Opus 529 overloads on the chat path.
    client = Anthropic(api_key=api_key, max_retries=5, timeout=180.0)

    # Persist the thread + the user message before streaming (so a refresh
    # mid-stream doesn't lose what the user asked).
    thread_id = req.context.thread_id
    if not thread_id and org_id and user_id:
        thread_id = _ensure_thread(org_id=org_id, user_id=user_id, period_id=period_id,
                                     title=_title_from_messages(req.messages))
        if thread_id:
            yield _sse({"type": "thread", "thread_id": thread_id})
    if thread_id:
        _append_user_message(thread_id, req.messages[-1].content if req.messages else "")

    final_usage = {"input_tokens": 0, "output_tokens": 0}
    full_text_chunks: List[str] = []

    # Tool-use loop. The Anthropic API may pause the response on tool_use; we
    # execute the tool, append the result, and resume. Limit at 4 hops to
    # avoid runaway loops.
    for hop in range(4):
        try:
            with client.messages.stream(
                model="claude-opus-4-7",
                max_tokens=4096,
                system=[
                    {
                        "type": "text",
                        "text": ASK_SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=incoming_messages,
                tools=TOOLS,
                output_config={"effort": "high"},
            ) as stream:
                pending_tool_uses: List[Dict[str, Any]] = []
                current_text_blocks: List[Dict[str, Any]] = []

                for event in stream:
                    et = getattr(event, "type", None)
                    if et == "text":
                        # Token delta. event.text holds the new piece.
                        delta_text = getattr(event, "text", "") or ""
                        if delta_text:
                            yield _sse({"type": "token", "text": delta_text})
                            full_text_chunks.append(delta_text)

                final_message = stream.get_final_message()

            # Accumulate usage across hops
            if final_message.usage is not None:
                final_usage["input_tokens"] += getattr(final_message.usage, "input_tokens", 0) or 0
                final_usage["output_tokens"] += getattr(final_message.usage, "output_tokens", 0) or 0

            stop_reason = getattr(final_message, "stop_reason", None)

            # Collect any tool_use blocks emitted; surface them and run them
            assistant_blocks: List[Dict[str, Any]] = []
            tool_uses: List[Dict[str, Any]] = []
            for block in final_message.content:
                btype = getattr(block, "type", None)
                if btype == "text":
                    assistant_blocks.append({"type": "text", "text": block.text or ""})
                elif btype == "tool_use":
                    assistant_blocks.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    })
                    tool_uses.append({"id": block.id, "name": block.name, "input": block.input})

            if stop_reason != "tool_use" or not tool_uses:
                break  # final answer reached

            # Emit tool_use events, run them, emit tool_result events, then
            # extend the messages array with the assistant turn + tool_result
            # blocks so the model can continue.
            tool_result_blocks: List[Dict[str, Any]] = []
            for tu in tool_uses:
                yield _sse({"type": "tool_use", "name": tu["name"], "input": tu["input"],
                            "tool_use_id": tu["id"]})
                output = _run_tool(tu["name"], tu["input"] or {},
                                   org_id=org_id, default_period_id=period_id)
                yield _sse({"type": "tool_result", "name": tu["name"], "output": output,
                            "tool_use_id": tu["id"]})
                tool_result_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": tu["id"],
                    "content": json.dumps(output, ensure_ascii=False, default=str),
                })

            # Round-trip the assistant turn + tool results back into the
            # conversation for the next hop.
            incoming_messages.append({"role": "assistant", "content": assistant_blocks})
            incoming_messages.append({"role": "user", "content": tool_result_blocks})

        except Exception as e:  # noqa: BLE001
            logger.exception("[ask] streaming failed")
            yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})
            return

    # Persist the assistant message and emit done
    full_text = "".join(full_text_chunks)
    if thread_id and full_text:
        _append_assistant_message(thread_id, full_text, final_usage)

    yield _sse({"type": "done", "usage": final_usage, "thread_id": thread_id})


# ─── Thread persistence (best-effort — table may not exist in dev) ──────────


def _ensure_thread(*, org_id: str, user_id: str, period_id: Optional[str],
                    title: Optional[str]) -> Optional[str]:
    try:
        with _supabase.admin() as client:
            new_thread = {
                "id": str(uuid.uuid4()),
                "org_id": org_id,
                "user_id": user_id,
                "title": (title or "New conversation")[:120],
                "active_period_id": period_id,
            }
            client.insert("chat_threads", new_thread, returning=False)
            return new_thread["id"]
    except Exception:  # noqa: BLE001
        logger.debug("[ask] chat_threads insert skipped (table may not exist yet)")
        return None


def _append_user_message(thread_id: str, content: str) -> None:
    try:
        with _supabase.admin() as client:
            client.insert(
                "chat_messages",
                {
                    "thread_id": thread_id,
                    "role": "user",
                    "content": content,
                },
                returning=False,
            )
    except Exception:  # noqa: BLE001
        logger.debug("[ask] user message persist skipped")


def _append_assistant_message(thread_id: str, content: str, usage: Dict[str, int]) -> None:
    try:
        with _supabase.admin() as client:
            client.insert(
                "chat_messages",
                {
                    "thread_id": thread_id,
                    "role": "assistant",
                    "content": content,
                    "tokens_input": usage.get("input_tokens", 0),
                    "tokens_output": usage.get("output_tokens", 0),
                },
                returning=False,
            )
            client.update(
                "chat_threads",
                {"updated_at": _now_iso()},
                filters={"id": f"eq.{thread_id}"},
            )
    except Exception:  # noqa: BLE001
        logger.debug("[ask] assistant message persist skipped")


def _title_from_messages(messages: List[AskMessage]) -> str:
    for m in messages:
        if m.role == "user" and m.content.strip():
            return m.content.strip()[:80]
    return "New conversation"


# ─── Router factory ─────────────────────────────────────────────────────────


def _wrap_stream_with_commit_release(
    inner: Iterator[bytes],
    user_id: Optional[str],
) -> Iterator[bytes]:
    """Pricing V3 (gap D, chat). Wraps the SSE generator so that:

      · clean completion  → commit_chat (reservation → consumed)
      · any exception     → release_chat (reservation dropped, no count)
      · client disconnect → also reaches commit (the generator's
        StopIteration fires; we treat the user-perceived "they got
        some response" as success). If you prefer release-on-disconnect,
        flip the `finally` branch — but the spec's "optional" note on
        gap D for chat lets us pick the friendlier semantics.

    Passthrough when enforcement is disabled or user_id is unknown.
    """
    from . import _usage_gate as _ug
    if not user_id or not _ug.enforcement_enabled():
        # Nothing to commit/release; just forward.
        yield from inner
        return

    errored = False
    try:
        yield from inner
    except Exception:
        errored = True
        try:
            _ug.release_chat(user_id)
        except Exception:
            logger.exception("[ask] release_chat failed (non-fatal)")
        raise
    finally:
        if not errored:
            try:
                _ug.commit_chat(user_id)
            except Exception:
                logger.exception("[ask] commit_chat failed (non-fatal)")


def build_router() -> APIRouter:
    router = APIRouter(tags=["ask"])

    @router.post("/api/ask")
    def ask(req: AskRequest, authorization: Optional[str] = Header(None)) -> StreamingResponse:
        jwt = _require_jwt(authorization)
        # Pricing V3 (refined-spec gaps C + D) — atomic reserve before
        # the Opus request, commit on stream completion, release on
        # stream error.
        #
        # Atomicity (gap C): `reserve_chat` locks the user_usage +
        # plan_chat_daily_usage rows FOR UPDATE inside a single RPC,
        # then conditionally increments the reservation. Two concurrent
        # /api/ask calls near a cap boundary serialize on the lock; only
        # one wins, the other gets the cap-reached response.
        #
        # Success-only commit (gap D, optional principle applied to
        # chat): the reservation is held while the Opus stream runs.
        # The streaming generator commits on a clean close and releases
        # on any error — see `_wrap_stream_with_commit_release` below.
        # If the cap check fails, NO Opus call is made; tokens are
        # never spent on a request that's about to be rejected.
        with _supabase.per_user(jwt) as _c:
            user = _c.get_user(jwt)
        _uid = (user or {}).get("id") if user else None
        if _uid:
            _usage_limits.check_quota(_uid, "llm_call")  # legacy safety rail
            from . import _usage_gate as _ug
            decision = _ug.reserve_chat(_uid)
            if decision.kind not in ("allowed", "disabled"):
                raise HTTPException(
                    status_code=429,
                    detail={
                        "code": "chat_cap_reached",
                        "kind": decision.kind,
                        "plan_key": decision.plan_key,
                        "daily_used": decision.daily_used,
                        "daily_cap": decision.daily_cap,
                        "monthly_used": decision.monthly_used,
                        "monthly_cap": decision.monthly_cap,
                        "message": decision.message,
                        "upgrade_url": "/pricing",
                    },
                )
        raw_generator = _stream_ask(jwt, req)
        # Wrap the generator so we commit on clean completion / release
        # on any exception. Enforcement off → wrapper is a passthrough.
        generator = _wrap_stream_with_commit_release(raw_generator, _uid)
        return StreamingResponse(
            generator,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # bypass nginx buffering
            },
        )

    @router.get("/api/ask/threads")
    def list_threads(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            try:
                rows = client.select(
                    "chat_threads",
                    order="updated_at.desc",
                    limit=50,
                )
            except Exception:  # noqa: BLE001
                rows = []
        return {"threads": rows}

    @router.get("/api/ask/threads/{thread_id}")
    def thread(thread_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            try:
                msgs = client.select(
                    "chat_messages",
                    filters={"thread_id": f"eq.{thread_id}"},
                    order="created_at.asc",
                )
            except Exception:  # noqa: BLE001
                msgs = []
        return {"thread_id": thread_id, "messages": msgs}

    return router
