"""Entity-resolution lane tests — public_market spine (PM6 focus).

Law under test: deterministic keys (ISIN / LEI / CIK) are the ONLY
auto-link authority. Name evidence — even when the pluggable AI
matcher is confident — can only ever queue a suggestion for review,
never link (PM1's "AI is never numeric-authoritative" applied to
identity: AI is never LINK-authoritative). Merge safety: external ids
and history are append-only, and any conflict refuses the WHOLE
record (no partial writes, nothing guessed).

Real-world constants: CIK 320193 / "Apple Inc." mirror the EDGAR
companyfacts sample fetched by the US adapter lane this wave
(scratchpad fetch/companyfacts_AAPL_full.json, fetched_at
2026-08-29T20:53:16Z); the Apple/Microsoft ISIN + LEI values are the
well-known public identifiers for the same entities, and every
checksum constant was cross-verified against the ISO algorithms
before being pinned here.
"""

from __future__ import annotations

import json

import pytest

from engine.public_market.entity import (
    AI_CONFIDENCE_GATE,
    DETERMINISTIC_KEY_PRECEDENCE,
    REASON_AI_ABOVE_GATE_BLOCKED,
    REASON_AI_BELOW_GATE,
    REASON_EXTERNAL_ID_CONFLICT,
    REASON_KEY_STRADDLE,
    REASON_KEY_VALUE_CONFLICT,
    REASON_NAME_MATCH_REQUIRES_REVIEW,
    REASON_NO_DETERMINISTIC_KEY,
    AiMatch,
    AutoLinkBlockedError,
    EntityRegistry,
    MalformedKeyError,
    MalformedProvenanceError,
    Provenance,
    ResolutionStatus,
    SourceRecord,
    ai_matcher_stub,
    mint_entity_id,
    normalize_cik,
    normalize_isin,
    normalize_lei,
    normalize_name,
)

# ── real-shape constants ────────────────────────────────────────────
APPLE_NAME = "Apple Inc."          # EDGAR entityName, real bytes
APPLE_CIK = "320193"               # EDGAR cik, real bytes
APPLE_CIK_PADDED = "0000320193"    # EDGAR zero-padded presentation
APPLE_ISIN = "US0378331005"
APPLE_LEI = "HWUPKR0MPOU8FGXBT394"
MSFT_ISIN = "US5949181045"
MSFT_LEI = "INR2EJN1ERAN0W5ZP974"

CLOCK = lambda: "2026-08-29T21:00:00+00:00"  # noqa: E731 — injected test clock


def prov(source="edgar", **kw):
    base = dict(
        source=source,
        as_of="2026-08-29",
        fetched_at="2026-08-29T20:53:16Z",
        accession=None,
        dataset_version="company_tickers_full-2026-08-29",
    )
    base.update(kw)
    return Provenance(**base)


def rec(**kw):
    base = dict(
        source="edgar",
        source_entity_id=APPLE_CIK,
        provenance=prov(),
        name=APPLE_NAME,
        isin=None,
        lei=None,
        cik=None,
    )
    base.update(kw)
    return SourceRecord(**base)


def make_registry(tmp_path, **kw):
    return EntityRegistry(
        review_queue_path=tmp_path / "review_queue.jsonl", clock=CLOCK, **kw
    )


# ── deterministic keys first ────────────────────────────────────────


def test_create_then_link_by_each_deterministic_key(tmp_path):
    reg = make_registry(tmp_path)
    created = reg.resolve(rec(cik=APPLE_CIK, isin=APPLE_ISIN, lei=APPLE_LEI))
    assert created.status is ResolutionStatus.CREATED
    eid = created.entity_id
    assert eid

    # Each key alone must find the same entity again.
    for key_kw in (
        dict(isin=APPLE_ISIN),
        dict(lei=APPLE_LEI),
        dict(cik=APPLE_CIK),
    ):
        out = reg.resolve(rec(source="xbrl_esef", source_entity_id=APPLE_LEI,
                              provenance=prov(source="xbrl_esef"), **key_kw))
        assert out.status is ResolutionStatus.LINKED
        assert out.entity_id == eid
    assert reg.review_queue == []


def test_cik_exact_match_is_normalization_aware(tmp_path):
    # EDGAR presents CIKs both zero-padded and bare; they are the SAME key.
    reg = make_registry(tmp_path)
    a = reg.resolve(rec(cik=APPLE_CIK_PADDED))
    b = reg.resolve(rec(cik=APPLE_CIK))
    assert a.status is ResolutionStatus.CREATED
    assert b.status is ResolutionStatus.LINKED
    assert b.entity_id == a.entity_id


def test_entity_id_stable_and_minted_from_first_key_in_precedence(tmp_path):
    assert DETERMINISTIC_KEY_PRECEDENCE == ("isin", "lei", "cik")

    reg1 = make_registry(tmp_path / "a")
    reg2 = make_registry(tmp_path / "b")
    e1 = reg1.resolve(rec(isin=APPLE_ISIN, cik=APPLE_CIK)).entity_id
    e2 = reg2.resolve(rec(isin=APPLE_ISIN, lei=APPLE_LEI)).entity_id
    # Same first deterministic key (the ISIN) -> same minted id, always.
    assert e1 == e2 == mint_entity_id("isin", APPLE_ISIN)

    # No ISIN -> LEI leads; no LEI either -> CIK.
    reg3 = make_registry(tmp_path / "c")
    e3 = reg3.resolve(rec(lei=APPLE_LEI, cik=APPLE_CIK)).entity_id
    assert e3 == mint_entity_id("lei", APPLE_LEI)
    reg4 = make_registry(tmp_path / "d")
    e4 = reg4.resolve(rec(cik=APPLE_CIK_PADDED)).entity_id
    assert e4 == mint_entity_id("cik", APPLE_CIK)  # minted from NORMALIZED form


def test_external_ids_map_per_source_and_append_only(tmp_path):
    reg = make_registry(tmp_path)
    eid = reg.resolve(rec(cik=APPLE_CIK)).entity_id
    reg.resolve(
        rec(source="gleif", source_entity_id=APPLE_LEI, lei=APPLE_LEI,
            cik=APPLE_CIK, provenance=prov(source="gleif"))
    )
    ent = reg.get(eid)
    assert ent.external_ids == {"edgar": APPLE_CIK, "gleif": APPLE_LEI}

    # Same source, same id again: idempotent no-op, still one mapping
    # per source.
    reg.resolve(rec(cik=APPLE_CIK))
    assert reg.get(eid).external_ids == {"edgar": APPLE_CIK, "gleif": APPLE_LEI}


def test_same_source_different_external_id_is_conflict_not_overwrite(tmp_path):
    reg = make_registry(tmp_path)
    eid = reg.resolve(rec(cik=APPLE_CIK)).entity_id
    before = reg.get(eid)
    history_before = before.history

    out = reg.resolve(rec(source_entity_id="999999", cik=APPLE_CIK))
    assert out.status is ResolutionStatus.CONFLICT
    assert out.reason == REASON_EXTERNAL_ID_CONFLICT
    assert out.entity_id is None  # a conflict never claims an entity

    after = reg.get(eid)
    assert after.external_ids == {"edgar": APPLE_CIK}  # unchanged
    assert after.history == history_before              # nothing appended
    assert len(reg.review_queue) == 1
    assert reg.review_queue[0]["reason"] == REASON_EXTERNAL_ID_CONFLICT


def test_key_straddle_across_two_entities_is_typed_conflict(tmp_path):
    reg = make_registry(tmp_path)
    a = reg.resolve(rec(isin=APPLE_ISIN, cik=APPLE_CIK)).entity_id
    b = reg.resolve(
        rec(source_entity_id="789019", cik="789019", isin=MSFT_ISIN,
            name="MICROSOFT CORP")
    ).entity_id
    assert a != b

    # One record claiming Apple's ISIN and Microsoft's CIK straddles both.
    out = reg.resolve(rec(source_entity_id="789019", isin=APPLE_ISIN, cik="789019"))
    assert out.status is ResolutionStatus.CONFLICT
    assert out.reason == REASON_KEY_STRADDLE
    entry = reg.review_queue[-1]
    assert set(entry["conflict"]["entity_ids"]) == {a, b}
    # Neither entity mutated.
    assert reg.get(a).cik == APPLE_CIK
    assert reg.get(b).isins == (MSFT_ISIN,)


def test_same_isin_different_cik_claim_is_conflict_never_guessed(tmp_path):
    reg = make_registry(tmp_path)
    eid = reg.resolve(rec(isin=APPLE_ISIN, cik=APPLE_CIK)).entity_id

    out = reg.resolve(rec(source_entity_id="111222", isin=APPLE_ISIN, cik="111222"))
    assert out.status is ResolutionStatus.CONFLICT
    assert out.reason == REASON_KEY_VALUE_CONFLICT
    ent = reg.get(eid)
    assert ent.cik == APPLE_CIK  # existing claim untouched, nothing guessed
    entry = reg.review_queue[-1]
    assert entry["conflict"]["kind"] == "cik"
    assert entry["conflict"]["existing"] == APPLE_CIK
    assert entry["conflict"]["claimed"] == "111222"


# ── key validation: fail closed, ABSENT != ZERO ─────────────────────


def test_malformed_keys_are_typed_refusals(tmp_path):
    reg = make_registry(tmp_path)
    with pytest.raises(MalformedKeyError):
        reg.resolve(rec(isin="US0378331006"))  # bad ISIN check digit
    with pytest.raises(MalformedKeyError):
        reg.resolve(rec(lei="HWUPKR0MPOU8FGXBT393"))  # bad LEI mod-97
    with pytest.raises(MalformedKeyError):
        reg.resolve(rec(cik="32O193"))  # letter O, not a digit
    with pytest.raises(MalformedKeyError):
        reg.resolve(rec(cik="0000000000"))  # all-zero CIK is no CIK (ABSENT != ZERO)
    assert reg.review_queue == []  # refusals happen BEFORE any write


def test_key_normalizers():
    assert normalize_isin(" us0378331005 ") == APPLE_ISIN
    assert normalize_lei("hwupkr0mpou8fgxbt394") == APPLE_LEI
    assert normalize_cik(APPLE_CIK_PADDED) == APPLE_CIK
    for bad in ("US03783310", "", None):
        with pytest.raises(MalformedKeyError):
            normalize_isin(bad)


def test_provenance_is_mandatory_and_fail_closed(tmp_path):
    reg = make_registry(tmp_path)
    with pytest.raises(MalformedProvenanceError):
        reg.resolve(rec(provenance=prov(accession=None, dataset_version=None)))
    with pytest.raises(MalformedProvenanceError):
        reg.resolve(rec(provenance=prov(fetched_at="")))
    with pytest.raises(MalformedProvenanceError):
        reg.resolve(rec(provenance=prov(as_of="yesterday")))
    with pytest.raises(MalformedProvenanceError):
        reg.resolve(rec(provenance=None))


# ── the deterministic name normalizer ───────────────────────────────


def test_normalize_name_diacritics_suffixes_case_and_ampersand():
    assert normalize_name("Apple Inc.") == "apple"
    assert normalize_name("NVIDIA CORP") == "nvidia"
    assert normalize_name("Țiriac Holdings S.R.L.") == "tiriac holdings"
    assert normalize_name("Société Générale S.A.") == "societe generale"
    assert normalize_name("Procter & Gamble Co.") == "procter and gamble"
    assert normalize_name("Ørsted A/S") == "orsted"
    assert normalize_name("Łódź Software Sp. z o.o.") == "lodz software"
    assert normalize_name("  Alphabet   Inc.  ") == "alphabet"
    # Stripping must never empty a name that IS a legal-suffix word.
    assert normalize_name("SE") == "se"


# ── PM6: name matching is queue-only, AI is confidence-gated ────────


def test_name_only_with_no_candidates_is_unlinked_and_queued(tmp_path):
    reg = make_registry(tmp_path)
    out = reg.resolve(rec(cik=None, name="Totally Unknown Holdings SRL"))
    assert out.status is ResolutionStatus.UNLINKED
    assert out.entity_id is None
    assert out.reason == REASON_NO_DETERMINISTIC_KEY
    assert reg.review_queue[-1]["reason"] == REASON_NO_DETERMINISTIC_KEY
    # A name-only record can never mint an entity (no stable key to hash).
    assert reg.entity_count == 0


def test_dark_stub_leaves_confidence_absent_not_zero(tmp_path):
    # Default matcher is the dark-ready stub: no AI layer, returns None.
    assert ai_matcher_stub("apple", ()) is None
    reg = make_registry(tmp_path)
    reg.resolve(rec(cik=APPLE_CIK, name="Apollo Global Management, Inc."))
    out = reg.resolve(rec(cik=None, name="Apollo Global Management"))
    assert out.status is ResolutionStatus.UNLINKED
    assert out.reason == REASON_NAME_MATCH_REQUIRES_REVIEW
    entry = reg.review_queue[-1]
    assert entry["ai_confidence"] is None  # ABSENT, never 0.0
    assert [c["entity_id"] for c in entry["candidates"]]


def test_pm6_ambiguous_match_at_085_is_unlinked_and_queued(tmp_path):
    def matcher(normalized_name, candidates):
        return AiMatch(entity_id=candidates[0].entity_id, confidence=0.85)

    reg = make_registry(tmp_path, ai_matcher=matcher)
    eid = reg.resolve(rec(cik=APPLE_CIK, name="Apollo Global Management, Inc.")).entity_id
    out = reg.resolve(rec(cik=None, name="Apollo Global"))
    assert out.status is ResolutionStatus.UNLINKED
    assert out.entity_id is None
    assert out.reason == REASON_AI_BELOW_GATE
    entry = reg.review_queue[-1]
    assert entry["ai_confidence"] == 0.85
    assert entry["ai_entity_id"] == eid
    # The entity itself gained nothing from the ambiguous record.
    assert [e["event"] for e in reg.get(eid).history] == ["created"]


def test_pm6_above_gate_without_deterministic_key_is_blocked(tmp_path):
    def confident_matcher(normalized_name, candidates):
        return AiMatch(entity_id=candidates[0].entity_id, confidence=0.97)

    reg = make_registry(tmp_path, ai_matcher=confident_matcher)
    eid = reg.resolve(rec(cik=APPLE_CIK, name="Apollo Global Management, Inc.")).entity_id

    nameless = rec(cik=None, name="Apollo Global Management")
    out = reg.resolve(nameless)
    # 0.97 > gate, but there is NO deterministic key: auto-link is blocked.
    assert AI_CONFIDENCE_GATE == 0.9
    assert out.status is ResolutionStatus.UNLINKED
    assert out.entity_id is None
    assert out.reason == REASON_AI_ABOVE_GATE_BLOCKED
    entry = reg.review_queue[-1]
    assert entry["ai_confidence"] == 0.97
    assert entry["ai_entity_id"] == eid

    # The explicit auto-link surface is a structural ban, not a soft check.
    with pytest.raises(AutoLinkBlockedError):
        reg.autolink_by_name(eid, nameless, confidence=0.97)
    # Still unlinked, still nothing written to the entity.
    assert reg.get(eid).external_ids == {"edgar": APPLE_CIK}


# ── merge safety: append-only history, durable queue ────────────────


def test_history_is_append_only_across_links(tmp_path):
    reg = make_registry(tmp_path)
    eid = reg.resolve(rec(cik=APPLE_CIK)).entity_id
    h1 = reg.get(eid).history
    assert [e["event"] for e in h1] == ["created"]

    reg.resolve(rec(source="gleif", source_entity_id=APPLE_LEI, lei=APPLE_LEI,
                    cik=APPLE_CIK, provenance=prov(source="gleif")))
    h2 = reg.get(eid).history
    assert h2[: len(h1)] == h1  # prior events byte-for-byte intact
    assert [e["event"] for e in h2] == ["created", "linked"]
    assert h2[1]["provenance"]["source"] == "gleif"


def test_review_queue_jsonl_is_append_only_and_replayable(tmp_path):
    path = tmp_path / "review_queue.jsonl"
    reg = EntityRegistry(review_queue_path=path, clock=CLOCK)
    reg.resolve(rec(cik=None, name="Unknown One"))
    reg.resolve(rec(cik=None, name="Unknown Two"))

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    parsed = [json.loads(line) for line in lines]
    assert [p["record"]["name"] for p in parsed] == ["Unknown One", "Unknown Two"]
    for p in parsed:
        assert p["queued_at"] == CLOCK()
        assert p["record"]["provenance"]["source"] == "edgar"
        assert p["ai_confidence"] is None
    # In-memory mirror matches the durable log.
    assert reg.review_queue == parsed
