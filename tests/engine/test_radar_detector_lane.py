"""THE DETECTOR LANE IN THE SERVING PATH — off by default, and real when on.

The pack-declared families (`engine.radar.detectors`) had no production
caller. They now run as a THIRD lane beside the single-period and
multi-period engines, ranked and capped by the same machinery — a finding
is a finding whatever produced it, and a second ranker here would be a
second policy about what a reader sees.

TWO PROPERTIES, and both are load-bearing:

  OFF, THE PAYLOAD IS WHAT IT WAS. The flag lives on the REQUEST, not in
  the environment, for two reasons that are easy to get wrong: `compose`
  is pure over its request and an env read inside it would end that, and
  the flag has to reach `cache_key` or a flip would serve the pre-flag
  answer out of cache for the life of the process.

  ON, THE LANE ACTUALLY PRODUCES RANKED FINDINGS. It did not, at first:
  every family that fired was refused with "the finding cites no money
  figure other than a company total", because the serving lane ranks on
  an AMOUNT AT STAKE and the detectors published only shares. Three
  fires, zero candidates, and a lane that looked wired and did nothing.

WHAT THIS REDS ON (TC-11)
  · the flag going missing from `cache_key` (a flip served from cache);
  · the payload moving with the lane off;
  · a lane that runs and produces no ranked candidate on a book where
    families demonstrably fire;
  · a refusal that does not say WHY — no pack, no identity, no accounts;
  · "off" and "ran and found nothing" becoming indistinguishable in the
    payload.

WHAT IT CANNOT SEE
  · any route calling this. Nothing does yet; the flag is off everywhere
    and there is no `/radar` surface. This gate does not imply one.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from dataclasses import replace

from engine.radar import serve as RS
from engine.radar import series as RS_SERIES

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar"
PACKS = str(REPO / "packs")
CASE = "saga_10_col_agras"


def _fixture(case=CASE):
    return json.loads((FIXTURES / (case + ".json")).read_text(encoding="utf-8"))


def _target(fx, line_items=True, cui="RO12345678"):
    digest = fx["envelope"]["provenance"]["content_hash"]
    return RS.PeriodInput(
        # The capture's own identifiers, so the off-path comparison is
        # against the committed bytes rather than a lookalike.
        period_id="p-%s" % CASE, label="FY%s" % fx["period_end"][:4],
        period_end=fx["period_end"], period_start=fx["period_start"],
        ordinal=0, currency=fx["currency"], statements=fx["statements"],
        envelope=fx["envelope"], snapshot_id=digest,
        source_document_id="doc-%s" % CASE, content_key=digest,
        line_items=(fx["line_items"] if line_items else None), cui=cui)


def _request(fx, **kw):
    return RS.RadarRequest(org_id="org-%s" % CASE, target=_target(fx, **{
        k: v for k, v in kw.items() if k in ("line_items", "cui")}),
        **{k: v for k, v in kw.items()
           if k not in ("line_items", "cui")})


def _on(fx, **kw):
    kw.setdefault("detector_jurisdiction", "ro")
    kw.setdefault("detector_pack_root", PACKS)
    return _request(fx, detectors_enabled=True, **kw)


# ── off ──────────────────────────────────────────────────────────────────


def test_the_lane_is_off_by_default():
    """RED ON: the flag defaulting on. A lane with no surface must not
    change a payload anybody already reads."""
    assert RS.RadarRequest(org_id="o", target=_target(_fixture())).detectors_enabled is False


def test_with_the_lane_off_the_payload_does_not_move():
    """RED ON: the wiring leaking into the off path. Compared against the
    COMMITTED capture, so this reds on any drift, not only on one the
    author expected."""
    fx = _fixture()
    served = RS.serve_period(_request(fx))
    assert RS.canonical_bytes(served) == RS.canonical_bytes(fx["radar"])


def test_off_and_ran_and_found_nothing_are_different_facts():
    """RED ON: the two collapsing into one shape. A reader has to be able
    to tell a lane that is switched off from one that ran and had nothing
    to say."""
    fx = _fixture()
    off = RS.serve_period(_request(fx))["lanes"]["detectors"]
    assert off == {"enabled": False}

    on = RS.serve_period(_on(fx))["lanes"]["detectors"]
    assert on["enabled"] is True
    assert "ran" in on and "waiting" in on and "candidates" in on


# ── the cache key ────────────────────────────────────────────────────────


def test_the_flag_is_key_material():
    """RED ON: the flag missing from `cache_key`. Without it, turning the
    lane on serves the pre-flag payload out of cache — the feature would
    look dead on exactly the deploy that enabled it."""
    fx = _fixture()
    off = RS.cache_key(_request(fx))
    on = RS.cache_key(_on(fx))
    assert off != on, "the same key for both states"
    other_pack = RS.cache_key(_on(fx, detector_jurisdiction="zz"))
    assert other_pack != on, "the jurisdiction is not key material"


# ── on ───────────────────────────────────────────────────────────────────


def test_the_lane_produces_ranked_findings_on_a_real_book():
    """THE MEASUREMENT. On agras, three families fire on the served tier
    and all three carry an amount at stake, so all three rank.

    RED ON: a lane that runs and produces no candidate — which is what it
    did until the families published the money figure the serving lane
    ranks on. Three fires and zero candidates looks identical to "nothing
    found" in every payload field except this one.
    """
    fx = _fixture()
    payload = RS.serve_period(_on(fx))
    lane = payload["lanes"]["detectors"]
    assert lane["notice"] is None, lane["notice"]
    assert lane["ran"], "no family ran at all"
    assert lane["candidates"] >= 3, (
        "the lane ran %d famil(ies) and produced %d ranked candidate(s)"
        % (len(lane["ran"]), lane["candidates"]))

    rows = [r for r in payload["surfaced"] if r["lane"] == RS.LANE_DETECTORS]
    assert len(rows) >= 3, [r["id"] for r in payload["surfaced"]]
    for row in rows:
        assert row["rank"], row["id"]
        amount = (row.get("materiality") or {}).get("amount")
        assert amount, (
            "%s surfaced with no amount at stake; the serving lane ranks "
            "on money and a share is not one" % row["id"])
        assert float(amount) > 0.0


def test_the_detector_rows_are_ranked_against_the_other_lanes_not_beside_them():
    """RED ON: the detector findings being appended after the engines'
    instead of interleaved. One cap, one order, one reader."""
    fx = _fixture()
    payload = RS.serve_period(_on(fx))
    lanes = [r["lane"] for r in payload["surfaced"]]
    assert RS.LANE_DETECTORS in lanes and RS.LANE_SINGLE in lanes
    first_detector = lanes.index(RS.LANE_DETECTORS)
    assert any(l == RS.LANE_SINGLE for l in lanes[first_detector:]), (
        "every single-lane row ranks above every detector row, which means "
        "they were concatenated rather than ranked together: %r" % lanes)
    ranks = [r["rank"] for r in payload["surfaced"]]
    assert ranks == sorted(ranks), ranks


def test_the_cap_governs_the_detector_rows_too():
    """RED ON: the lane pushing the surfaced list past the cap. The cap is
    the reader's attention budget and it does not care which lane spent
    it."""
    fx = _fixture()
    payload = RS.serve_period(_on(fx))
    assert len(payload["surfaced"]) <= int(payload["cap"])


# ── the refusals ─────────────────────────────────────────────────────────


def test_no_pack_named_is_a_refusal_that_says_so():
    """RED ON: a missing pack reading as 'nothing found'."""
    fx = _fixture()
    lane = RS.serve_period(_request(fx, detectors_enabled=True))["lanes"]["detectors"]
    assert lane["enabled"] is True
    assert "no jurisdiction pack was named" in (lane["notice"] or "")
    assert lane["candidates"] == 0


def test_a_workspace_identity_reaches_the_spine(monkeypatch):
    """THE DEFECT THE FLAG CAUGHT, the first time it was turned on.

    `_detector_spine` built its entity with `EntityKey.of`, which
    NORMALIZES — and `normalize_cui` strips `workspace:<uuid>` to nothing,
    so the lane refused with "cannot normalize a CUI from
    'workspace:qa-org'". That is what the serving path actually carries,
    because `financial_periods` has no CUI column, so every real period
    refused: 0 families run on a book where 5 do.

    Nothing in the lane's own suite could see it — every other test in
    this file passes a CUI-shaped identity. RED ON: the workspace
    identity being routed through the CUI constructor again.
    """
    fx = _fixture()
    workspace = RS_SERIES.WORKSPACE_IDENTITY_PREFIX + "org-%s" % CASE
    target = _target(fx)
    target = replace(target, cui=workspace)
    request = RS.RadarRequest(
        org_id="org-%s" % CASE, target=target, detectors_enabled=True,
        detector_jurisdiction="ro", detector_pack_root=PACKS)
    lane = RS.serve_period(request)["lanes"]["detectors"]
    assert lane["notice"] is None, lane["notice"]
    assert lane["ran"], "no family ran on a workspace-identified spine"
    assert lane["candidates"] >= 3, lane


def test_no_company_identity_is_a_refusal_that_says_so():
    """RED ON: a spine built without an identity to check against. A
    series that cannot say which company it is for is the one thing the
    spine must never produce."""
    fx = _fixture()
    lane = RS.serve_period(_on(fx, cui=None))["lanes"]["detectors"]
    assert "company identity" in (lane["notice"] or ""), lane["notice"]
    assert lane["candidates"] == 0


def test_a_period_with_no_loaded_accounts_still_runs_the_closing_families():
    """A period whose route did not load `statement_line_items` is a HOLE,
    declared as one rather than dropped — dropping it would let a quiet
    run be measured across the gap. With the TARGET carrying none there
    is nothing to read, and the families say so by name.

    RED ON: a missing line-item load reading as an empty book with clean
    checks.
    """
    fx = _fixture()
    payload = RS.serve_period(_on(fx, line_items=False))
    lane = payload["lanes"]["detectors"]
    assert lane["enabled"] is True
    assert lane["notice"] is None
    assert lane["candidates"] == 0
    notes = " ".join(str(c.get("note") or "") for c in payload["checks"]
                     if c.get("lane") == RS.LANE_DETECTORS)
    assert notes.strip(), "the lane produced no check rows at all"


def test_every_detector_check_row_carries_the_lane_that_produced_it():
    """RED ON: a detector check row that cannot be told from a rule row.
    One renderer reads this list; a row with no lane is a row whose origin
    a reader cannot walk back to."""
    fx = _fixture()
    payload = RS.serve_period(_on(fx))
    rows = [c for c in payload["checks"] if c.get("lane") == RS.LANE_DETECTORS]
    assert len(rows) >= 10, len(rows)
    for row in rows:
        assert row.get("rule_id"), row
        assert row.get("note"), row


def test_the_payload_still_reads_back_as_canonical_bytes():
    """RED ON: the lane putting an unserializable object on the payload."""
    fx = _fixture()
    payload = RS.serve_period(_on(fx))
    assert json.loads(RS.canonical_bytes(payload).decode("utf-8")
                      if isinstance(RS.canonical_bytes(payload), bytes)
                      else RS.canonical_bytes(payload))


def test_ten_runs_with_the_lane_on_are_byte_identical():
    """R4, extended to the new lane. RED ON: a set iteration, a dict order
    or a clock reaching the detector path."""
    fx = _fixture()
    request = _on(fx)
    runs = set(RS.canonical_bytes(RS.serve_period(request)) for _ in range(10))
    assert len(runs) == 1, "%d distinct payloads in 10 runs" % len(runs)
