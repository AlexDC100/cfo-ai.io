"""STREAM 3 / AMP-1 — an anonymous request has a STATED worst case.

WHAT WAS MEASURED, 2026-09-06, locally, against the real ``create_app()``,
anonymous, no bearer, nothing in front of it (the full table is in
deploy/REQUEST_BODY_LIMITS.md)::

    POST /api/skus       20,205,482 in -> 200, 56,989,094 out  (2.82x)  3.45 s
    POST /api/skus       19,689,462 in -> 422, 42,009,599 out  (2.13x)  3.46 s
    POST /api/drill      19,689,483 in -> 422, 42,009,599 out  (2.13x)  3.39 s
    POST /api/cfo/today  19,674,808 in -> 422, 39,984,904 out  (2.03x)  3.32 s

Two defects, one symptom:

  * **No size limit anywhere.** No ``client_max_body_size`` in nginx.conf
    (which serves the SPA only), none in the app. The ceiling was
    whatever the front proxy happened to allow.
  * **The validator echoed the attack back.** FastAPI's default
    ``RequestValidationError`` handler returns ``exc.errors()`` verbatim
    and every entry carries the offending ``input``, so the FAILURE path
    amplified with no schema knowledge required.

WHAT EACH TEST FAILS ON AFTER THE REPAIR (TC-11)

  · ``test_a_body_over_the_general_cap_is_refused_at_413`` reds if
    ``BodyLimitMiddleware`` is removed or its cap raised past 8 MiB — the
    message names the route, the bytes in and the bytes out, so the
    failure reads as the amplification measurement it is.
  · ``test_the_413_body_is_small_and_designed`` reds if the refusal ever
    becomes an amplifier itself (an echo of the body, a stack trace) or
    loses its ``request_too_large`` envelope code.
  · ``test_a_body_under_the_cap_is_unaffected`` is the non-vacuity half:
    it reds if the cap is set so low that a legitimate dataset is
    refused, which would make the first test pass for the wrong reason.
    It posts the real-world row count, not a token one.
  · ``test_the_document_paths_keep_their_higher_cap`` reds if the 25 MB
    PDF path is squeezed by the general cap.
  · ``test_a_validation_failure_is_bounded_regardless_of_row_count``
    reds if the unbounded echo returns: it runs N = 1 and N = 20,000 and
    asserts the SAME ceiling for both, so a handler that scales with N
    cannot pass at either end.
  · ``test_the_bounded_422_is_still_useful`` is that test's non-vacuity
    half: a handler that returned ``{"detail": []}`` would satisfy every
    size assertion above and be worthless. This one demands the field,
    the row index, the reason and a (clipped) echo of what was sent.
  · ``test_the_amplification_factor_is_under_one_on_the_failure_path``
    asserts the amplification as a NUMBER — bytes_out / bytes_in — on
    the exact route and body shape that measured 2.13x.
  · ``test_the_chunked_body_without_a_content_length_is_also_capped``
    reds if the cap is implemented as a header check only. A caller who
    omits ``content-length`` must not walk past it.

WHAT THESE GATES CANNOT SEE

  · **The proxy hops.** This suite exercises the ASGI app. It cannot
    observe nginx's ``client_max_body_size`` or the Caddy front's
    ``request_body max_size`` — those are config on two other machines,
    and the operator delta for Caddy is in deploy/REQUEST_BODY_LIMITS.md.
    The app-level cap is what holds when a request does not pass through
    either, which is the reason it exists.
  · **Concurrency.** A cap bounds ONE request. Thirty capped requests in
    parallel are still thirty. ``/api/cfo/*`` has no rate limiter
    (backlog LB-RL-1); nothing here tests that.
  · **A lying ``content-length``.** With length framing the transport
    itself delivers exactly the declared byte count, so the declaration
    is the ceiling — but that is h11/uvicorn's guarantee, not this
    middleware's, and TestClient cannot forge the disagreement.
  · **Wall time.** Seconds are measured in the report, not asserted here:
    a timing assertion on a shared CI box is a flake, not a gate.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"

from engine.api.server import (  # noqa: E402
    DOCUMENT_BODY_LIMIT_BYTES,
    GENERAL_BODY_LIMIT_BYTES,
    VALIDATION_RESPONSE_CEILING_BYTES,
    create_app,
)

#: The largest real SKU dataset in this repo
#: (files/Trading_analysis_YTDOct'25_LV.xlsx) has this many rows, and
#: serializes at 200.4 bytes/row -> 1,925,012 bytes. The general cap must
#: clear it with room to spare; `test_a_body_under_the_cap_is_unaffected`
#: posts this count so "the cap broke the product" is a red, not a shrug.
LARGEST_REAL_DATASET_ROWS = 9604
MEASURED_REAL_DATASET_BYTES = 1_925_012

#: The 413 payload is designed, not incidental. Anything approaching this
#: would mean the refusal had itself become an echo.
MAX_REFUSAL_BYTES = 1024

#: THE STATED WORST CASE for an anonymous request, measured 2026-09-06 at
#: the cap boundary (8,388,608 - 1,024 bytes in) across all five routes::
#:
#:   route              in         status  out(decoded)  out(wire, gzip)  secs
#:   /api/skus          8,357,801  200     23,578,467    730,551          1.70
#:   /api/drill         8,357,822  200        322,203      9,517          0.57
#:   /api/classify-rows 8,357,823  200          9,313      1,046          0.53
#:   /api/alerts        8,357,801  200         75,558      3,994          0.48
#:   /api/cfo/today     8,366,708  200            579        579          0.58
#:   (every one of them, INVALID rows)  422      3,541        391       <=0.39
#:
#: `/api/skus` is the ceiling: it returns one enriched record per input
#: row, so its response IS proportional to its input — that is the shape
#: of the endpoint, not a defect. What was the defect is that nothing
#: bounded the input. 24 MiB is the stated ceiling on the decoded body.
#: Seconds are recorded, not asserted: a timing assertion on a shared box
#: is a flake, not a gate.
STATED_WORST_CASE_BYTES_OUT = 24 * 1024 * 1024      # 25,165,824
MEASURED_WORST_CASE_BYTES_OUT = 23_578_467
MEASURED_WORST_CASE_SECONDS = 1.70


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app(), raise_server_exceptions=False)


# ── body generators (in memory; no fixture is committed) ─────────────────

def _valid_row(i: int) -> Dict[str, Any]:
    return {"category": "CAT-%d" % (i % 40), "sku": "SKU-%d-%s" % (i, "N" * 40),
            "volume_tons": 1.0, "revenue_kron": 100.0,
            "gross_margin_pct": 20.0, "dio_days": 30}


def _invalid_row(i: int) -> Dict[str, Any]:
    """Three errors per row. ``gross_margin_pct`` carries a 96-byte string
    the default handler used to echo back verbatim, once per row."""
    return {"category": "CAT-" + "P" * 60, "sku": "SKU-%d" % i,
            "volume_tons": -1, "revenue_kron": -1,
            "gross_margin_pct": "P" * 96}


def _cfo_row(i: int) -> Dict[str, Any]:
    return {"sku_id": "S%d" % i, "sku_name": "N%d-%s" % (i, "P" * 40),
            "category": "C%d" % (i % 20), "volume_tons": 1.0,
            "revenue_kron": 100.0, "gross_margin_pct": 20.0, "dio_days": 30}


def _envelope(path: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Each route's OWN valid request shape.

    Load-bearing: posting an ``/api/skus`` envelope at ``/api/drill``
    would make that parametrized case fail validation instead of doing
    the work, and its red would then measure nothing.
    """
    if path == "/api/drill":
        return {"category": "CAT-0", "rows": rows, "period_months": 10}
    if path == "/api/classify-rows":
        return {"rows": rows, "period_months": 10, "data_period": "YTD"}
    if path == "/api/cfo/today":
        return {"skus": rows, "categories": [], "period_months": 10,
                "company": {"name": "X", "industry": "food", "currency": "RON"}}
    return {"rows": rows, "period_months": 10}      # /api/skus, /api/alerts


def _skus_body(rows: List[Dict[str, Any]]) -> bytes:
    return json.dumps(_envelope("/api/skus", rows)).encode()


def _body_of_at_least(target_bytes: int, path: str = "/api/skus") -> bytes:
    """Grow a VALID body in `path`'s own shape until it clears `target`."""
    make = _cfo_row if path == "/api/cfo/today" else _valid_row
    count = max(1, target_bytes // 120)
    body = json.dumps(_envelope(path, [make(i) for i in range(count)])).encode()
    while len(body) <= target_bytes:
        count = int(count * 1.2) + 1
        body = json.dumps(_envelope(path, [make(i) for i in range(count)])).encode()
    return body


def _body_of_at_most(ceiling: int) -> bytes:
    """The largest VALID /api/skus body that still fits under `ceiling`.

    Grows in fine steps rather than the coarse 1.2x of the helper above:
    this one is used to sit AT the cap, and an overshoot would test the
    413 path by accident.
    """
    per_row = len(json.dumps(_valid_row(0)).encode()) + 2
    count = max(1, (ceiling - 64) // per_row)
    body = _skus_body([_valid_row(i) for i in range(count)])
    while len(body) > ceiling and count > 1:
        count = int(count * 0.97) or 1
        body = _skus_body([_valid_row(i) for i in range(count)])
    return body


def _post(client: TestClient, path: str, body: bytes) -> Any:
    return client.post(path, content=body,
                       headers={"content-type": "application/json"})


# ── 1. the cap ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", ["/api/skus", "/api/drill",
                                  "/api/classify-rows", "/api/alerts",
                                  "/api/cfo/today"])
def test_a_body_over_the_general_cap_is_refused_at_413(client, path):
    body = _body_of_at_least(GENERAL_BODY_LIMIT_BYTES, path)
    r = _post(client, path, body)
    assert r.status_code == 413, (
        "POST %s answered %d to a %d-byte anonymous body and sent %d bytes "
        "back (amplification %.2fx). The stated cap is %d bytes. Before this "
        "cap existed, 20,205,482 bytes into POST /api/skus answered 200 with "
        "56,989,094 bytes in 3.45 s."
        % (path, r.status_code, len(body), len(r.content),
           len(r.content) / float(len(body)), GENERAL_BODY_LIMIT_BYTES))


def test_the_413_body_is_small_and_designed(client):
    body = _body_of_at_least(GENERAL_BODY_LIMIT_BYTES)
    r = _post(client, "/api/skus", body)
    assert r.status_code == 413
    assert len(r.content) < MAX_REFUSAL_BYTES, (
        "the refusal is %d bytes — a refusal that grows with the request is "
        "the amplifier wearing a different status code" % len(r.content))
    payload = r.json()
    assert payload["error"]["code"] == "request_too_large", payload
    assert payload["error"]["details"]["limit_bytes"] == GENERAL_BODY_LIMIT_BYTES
    # The refusal must not echo the body back under any key.
    assert "P" * 60 not in r.text and "SKU-" not in r.text, r.text[:300]


def test_a_body_under_the_cap_is_unaffected(client):
    """Non-vacuity: the cap must not have broken the product.

    Posts the row count of the LARGEST real dataset in the repo.
    """
    rows = [_valid_row(i) for i in range(LARGEST_REAL_DATASET_ROWS)]
    body = _skus_body(rows)
    assert len(body) < GENERAL_BODY_LIMIT_BYTES, (
        "the real-world dataset (%d rows, %d bytes) does not fit under the "
        "%d-byte cap — the cap is set below what the product must serve"
        % (LARGEST_REAL_DATASET_ROWS, len(body), GENERAL_BODY_LIMIT_BYTES))
    r = _post(client, "/api/skus", body)
    assert r.status_code == 200, (
        "the largest real dataset (%d rows, %d bytes; the measured real body "
        "is %d bytes) was answered %d: %s"
        % (LARGEST_REAL_DATASET_ROWS, len(body), MEASURED_REAL_DATASET_BYTES,
           r.status_code, r.text[:300]))
    assert r.json()["sku_count"] > 0


def test_the_document_paths_keep_their_higher_cap():
    """`pdf_b64` legitimately carries 33.4 MB of base64 (a 25 MB PDF)."""
    from engine.api.server import body_limit_for

    assert body_limit_for("/api/financial-statements/parse") == DOCUMENT_BODY_LIMIT_BYTES
    assert body_limit_for("/api/firm/requests/abc123/upload") == DOCUMENT_BODY_LIMIT_BYTES
    assert body_limit_for("/api/skus") == GENERAL_BODY_LIMIT_BYTES
    # 25 MB decoded PDF -> 4/3 base64 = 33,554,432 bytes, plus envelope.
    assert DOCUMENT_BODY_LIMIT_BYTES > (25 * 1024 * 1024) * 4 // 3, (
        "the document cap (%d) is below the 25 MB PDF ceiling the parse "
        "route states for itself, once base64 inflation is counted"
        % DOCUMENT_BODY_LIMIT_BYTES)


def test_the_chunked_body_without_a_content_length_is_also_capped(client):
    """A header check alone is not a cap.

    httpx sends a generator body with `Transfer-Encoding: chunked` and no
    `content-length`, which is exactly the shape a header-only
    implementation walks past.
    """
    payload = _body_of_at_least(GENERAL_BODY_LIMIT_BYTES)

    def _chunks():
        for i in range(0, len(payload), 65536):
            yield payload[i:i + 65536]

    r = client.post("/api/skus", content=_chunks(),
                    headers={"content-type": "application/json"})
    assert r.status_code == 413, (
        "a chunked %d-byte body (no content-length) was answered %d with %d "
        "bytes out — the cap is a header check, not a cap"
        % (len(payload), r.status_code, len(r.content)))
    assert r.json()["error"]["code"] == "request_too_large"


# ── 2. the bounded echo ──────────────────────────────────────────────────

@pytest.mark.parametrize("n_rows", [1, 20_000])
def test_a_validation_failure_is_bounded_regardless_of_row_count(client, n_rows):
    """N = 1 and N = 20,000 must answer under the SAME ceiling.

    20,000 rows x 3 errors = 60,000 validation errors. The default
    handler echoed every one of their `input` values.
    """
    body = _skus_body([_invalid_row(i) for i in range(n_rows)])
    r = _post(client, "/api/skus", body)
    assert r.status_code == 422, r.text[:300]
    assert len(r.content) < VALIDATION_RESPONSE_CEILING_BYTES, (
        "POST /api/skus with %d invalid rows: %d bytes in -> %d bytes out "
        "(amplification %.2fx). The stated ceiling is %d bytes. Before this "
        "handler, 19,689,462 bytes of invalid rows answered with 42,009,599."
        % (n_rows, len(body), len(r.content),
           len(r.content) / float(len(body)), VALIDATION_RESPONSE_CEILING_BYTES))


def test_the_amplification_factor_is_under_one_on_the_failure_path(client):
    """The measurement, as a NUMBER, on the route that measured 2.13x."""
    body = _skus_body([_invalid_row(i) for i in range(20_000)])
    r = _post(client, "/api/skus", body)
    factor = len(r.content) / float(len(body))
    assert factor < 0.01, (
        "POST /api/skus failure path amplifies %.3fx (%d bytes in, %d bytes "
        "out). It measured 2.13x on 2026-09-06; anything at or above 1.0 "
        "means an anonymous caller still gets more bytes back than they sent."
        % (factor, len(body), len(r.content)))


def test_the_worst_case_an_anonymous_request_can_buy_is_the_stated_number(client):
    """THE LAW, as a NUMBER: the most an anonymous caller can extract.

    Posts the largest body the cap admits to the route with the largest
    response (`/api/skus` returns one enriched record per input row), and
    asserts the stated ceiling on the bytes that come back. Before the
    cap, the same shape at 20,205,482 bytes in answered 200 with
    56,989,094 bytes out in 3.45 s, and nothing stopped 200 MB.
    """
    body = _body_of_at_most(GENERAL_BODY_LIMIT_BYTES - 1024)
    assert len(body) < GENERAL_BODY_LIMIT_BYTES, len(body)
    assert len(body) > GENERAL_BODY_LIMIT_BYTES * 0.9, (
        "the probe body (%d) is not actually near the cap (%d) — this test "
        "would then measure a comfortable request, not the worst case"
        % (len(body), GENERAL_BODY_LIMIT_BYTES))
    r = _post(client, "/api/skus", body)
    assert r.status_code == 200, r.text[:300]
    assert len(r.content) < STATED_WORST_CASE_BYTES_OUT, (
        "POST /api/skus at the cap: %d bytes in -> %d bytes out. The stated "
        "worst case is %d (measured %d on 2026-09-06). A response that has "
        "grown past it means the cap no longer bounds what one anonymous "
        "request costs."
        % (len(body), len(r.content), STATED_WORST_CASE_BYTES_OUT,
           MEASURED_WORST_CASE_BYTES_OUT))


def test_the_bounded_422_is_still_useful(client):
    """Non-vacuity: `{"detail": []}` would pass every size assertion.

    A developer must still learn WHICH FIELD of WHICH ROW failed, WHY,
    and how many rows failed in total.
    """
    body = _skus_body([_invalid_row(i) for i in range(500)])
    r = _post(client, "/api/skus", body)
    assert r.status_code == 422
    payload = r.json()

    detail = payload["detail"]
    assert detail, "the 422 carries no errors at all — bounded into uselessness"

    # WHICH FIELD, WHICH ROW: `loc` still locates the failure precisely.
    locs = [tuple(d["loc"]) for d in detail]
    assert ("body", "rows", 0, "volume_tons") in locs, locs[:5]
    assert ("body", "rows", 0, "gross_margin_pct") in locs, locs[:5]

    # WHY: the reason survives.
    by_loc = {tuple(d["loc"]): d for d in detail}
    assert "greater than or equal to 0" in by_loc[
        ("body", "rows", 0, "volume_tons")]["msg"]

    # WHAT WAS SENT: a clipped echo, not the 96-byte payload verbatim.
    echo = by_loc[("body", "rows", 0, "gross_margin_pct")]["input"]
    assert echo, "the input echo was removed entirely — the error is now unusable"
    assert len(echo) <= 130, "the echo is not clipped: %d chars" % len(echo)

    # HOW MANY: the count the caller cannot get from a truncated list.
    assert payload["error_count"] == 1500, payload["error_count"]
    assert payload["truncated"] is True

    # The route-binding gate reads `detail[].type`; it must survive.
    assert all("type" in d for d in detail)


def test_the_query_shape_offender_still_surfaces_in_a_bounded_422(client):
    """`tests/engine/test_route_bindings.py` scans `detail[]` for
    ``loc[:1] == ["query"]``. Truncation must not hide it."""
    r = client.post("/api/drill", content=b"{}",
                    headers={"content-type": "application/json"})
    assert r.status_code == 422
    locs = [tuple(d["loc"]) for d in r.json()["detail"]]
    assert ("body", "category") in locs, locs
