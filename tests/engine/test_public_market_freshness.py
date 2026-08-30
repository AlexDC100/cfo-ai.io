"""Tests for the public_market AI freshness layer (Part D).

Covers, in order:
  * the PM1 lint (owned by this lane): the freshness package may NEVER gain
    an import path into the numeric spine's serving/persistence write APIs
    -- briefings can never write a number into the served facts;
  * D1 briefing: citation contract, drop-and-count, (entity, day) cache,
    dark behavior, budget refusal, invalid-output refusal;
  * D2 filing reader: figures echoed FROM facts, mismatches flagged and
    never corrected, unknown/absent facts dropped (ABSENT != ZERO), cache;
  * D3 sentinel: deterministic staleness (never_seen fails closed to stale),
    per-day queue dedup, summary record, AI identity proposals are
    review-queue-only (no other file is touched), dark behavior;
  * D4 peers: deterministic (sector, size band) selection and ordering,
    dark -> "standard ordering", AI reorder only on exact permutation;
  * D5 budget: per-role caps with a typed budget_exhausted refusal;
  * the operator CLI end to end (subprocess, dark env).
"""

import ast
import datetime
import io
import json
import os
import subprocess
import sys

import pytest

# Repo-standard bootstrap so the test runs from a clean checkout without an
# installed engine package.
_REPO_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
_SRC = os.path.join(_REPO_ROOT, "src")
if os.path.isdir(_SRC) and _SRC not in sys.path:
    sys.path.insert(0, _SRC)

import engine.public_market.freshness as freshness_pkg  # noqa: E402
from engine.public_market.freshness import (  # noqa: E402
    DARK_NOTICE,
    AiResult,
    AiUnavailable,
    DarkAiClient,
    LocalSpendCounter,
    parse_model_json,
    resolve_ai_client,
)
from engine.public_market.freshness import briefing as briefing_mod  # noqa: E402
from engine.public_market.freshness import filing_reader as filing_mod  # noqa: E402
from engine.public_market.freshness import peers as peers_mod  # noqa: E402
from engine.public_market.freshness import sentinel as sentinel_mod  # noqa: E402

NOW = datetime.datetime(2026, 8, 30, 12, 0, 0, tzinfo=datetime.timezone.utc)


class FakeAiClient(object):
    """Scripted client: each complete() pops the next canned reply."""

    is_dark = False

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def complete(self, role, prompt, max_tokens=1500, want_web_search=False):
        self.calls.append(
            {"role": role, "prompt": prompt, "want_web_search": want_web_search}
        )
        assert self.replies, "client called more times than scripted"
        item = self.replies.pop(0)
        if isinstance(item, AiUnavailable):
            return item
        return AiResult(text=item, model="fake-flagship", role=role)


def open_breaker():
    return LocalSpendCounter(caps={}, env={"PM_AI_CALL_CAP": "100"})


def snapshot_tree(root):
    """All files under root -> {relpath: bytes}."""
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, root)] = fh.read()
    return out


# ---------------------------------------------------------------------------
# PM1 lint -- the freshness package can never reach a spine write API
# ---------------------------------------------------------------------------

# Import prefixes of the deterministic numeric spine. The freshness layer
# reads NOTHING from these modules and writes nothing through them; every
# number it handles is passed in by the caller as plain data.
FORBIDDEN_IMPORT_PREFIXES = (
    "engine.serving",
    "engine.public_ro",
    "engine.api",
    "engine.pipeline",
    "engine.passes",
    "engine.consensus",
    "engine.frontends",
    "engine.interp",
    "engine.journal",
    "engine.public_market.store",
)

# Raw tokens of persistence/mutation surfaces. Substring scan over source so
# even a dynamically-built call (getattr tricks, string dispatch) trips it.
FORBIDDEN_TOKENS = (
    "write_fact",
    "put_fact",
    "upsert",
    "set_fact",
    "delete_fact",
    "save_fact",
    "mutate_fact",
    "facts_store",
    "FactsStore",
    "served_facts",
    "serving.facts",
    "store.write",
)

# E8-style allowlist: empty today; any future exception must be added here
# deliberately, with a comment, in a reviewed diff.
PM1_ALLOWLIST = frozenset()


def _freshness_source_files():
    pkg_dir = os.path.dirname(os.path.abspath(freshness_pkg.__file__))
    for fn in sorted(os.listdir(pkg_dir)):
        if fn.endswith(".py"):
            yield os.path.join(pkg_dir, fn)


def test_pm1_lint_no_spine_write_imports():
    violations = []
    for path in _freshness_source_files():
        rel = os.path.basename(path)
        if rel in PM1_ALLOWLIST:
            continue
        with io.open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    for prefix in FORBIDDEN_IMPORT_PREFIXES:
                        if alias.name == prefix or alias.name.startswith(prefix + "."):
                            violations.append(
                                "%s:%d imports %s" % (rel, node.lineno, alias.name)
                            )
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if node.level >= 2:
                    # No relative import may climb above the freshness
                    # package (e.g. `from ..store import ...`).
                    violations.append(
                        "%s:%d relative import climbs out of the package (level %d)"
                        % (rel, node.lineno, node.level)
                    )
                elif node.level == 1 and module.split(".")[0] == "store":
                    violations.append(
                        "%s:%d relative import of a store module" % (rel, node.lineno)
                    )
                else:
                    for prefix in FORBIDDEN_IMPORT_PREFIXES:
                        if module == prefix or module.startswith(prefix + "."):
                            violations.append(
                                "%s:%d imports from %s" % (rel, node.lineno, module)
                            )
    assert not violations, (
        "PM1 violation -- the freshness package must never import the "
        "spine's serving/persistence write surface:\n" + "\n".join(violations)
    )


def test_pm1_lint_no_mutation_tokens():
    violations = []
    for path in _freshness_source_files():
        rel = os.path.basename(path)
        if rel in PM1_ALLOWLIST:
            continue
        with io.open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        for token in FORBIDDEN_TOKENS:
            if token in source:
                violations.append("%s contains forbidden token %r" % (rel, token))
    assert not violations, "PM1 violation:\n" + "\n".join(violations)


def test_pm1_lint_actually_detects():
    """The lint must not be vacuous: feed it a poisoned module text."""
    poisoned = "from engine.serving.facts import something\n"
    tree = ast.parse(poisoned)
    hits = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and any(
            (node.module or "").startswith(p) for p in FORBIDDEN_IMPORT_PREFIXES
        )
    ]
    assert hits, "lint prefix table failed to catch a spine import"


# ---------------------------------------------------------------------------
# Client hook / dark activation
# ---------------------------------------------------------------------------

def test_resolve_ai_client_dark_without_key():
    client = resolve_ai_client(env={})
    assert client.is_dark
    reply = client.complete("pm_briefing", "hello")
    assert isinstance(reply, AiUnavailable)
    assert reply.reason == "credits_absent"
    assert reply.notice == DARK_NOTICE


def test_resolve_ai_client_live_with_key():
    client = resolve_ai_client(env={"ANTHROPIC_API_KEY": "sk-test"})
    assert not client.is_dark  # self-activation is just the env var


def test_parse_model_json_tolerates_fences():
    assert parse_model_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_model_json('prose... {"a": [1, 2]} trailing') == {"a": [1, 2]}
    assert parse_model_json("no json here at all") is None
    assert parse_model_json("") is None


# ---------------------------------------------------------------------------
# D1 briefing
# ---------------------------------------------------------------------------

BRIEFING_REPLY = json.dumps(
    {
        "claims": [
            {
                "claim": "Announced a new plant in Cluj.",
                "source_url": "https://news.example.com/plant",
                "article_date": "2026-08-28",
            },
            {
                "claim": "CEO stepped down.",
                "source_url": "https://news.example.com/ceo",
                "article_date": "2026-08-25",
            },
            {  # no source_url -> must be dropped and counted
                "claim": "Rumored acquisition talks.",
                "article_date": "2026-08-27",
            },
            {  # impossible date -> dropped and counted
                "claim": "Guidance raised.",
                "source_url": "https://news.example.com/guidance",
                "article_date": "2026-13-45",
            },
            {  # source present but not a URL -> dropped and counted
                "claim": "New CFO appointed.",
                "source_url": "heard from a colleague",
                "article_date": "2026-08-26",
            },
        ]
    }
)


def test_briefing_dark_returns_typed_unavailable(tmp_path):
    result = briefing_mod.build_briefing(
        "US:AAPL", DarkAiClient(), open_breaker(), str(tmp_path), now=NOW
    )
    assert result.status == "unavailable"
    assert result.unavailable is not None
    assert result.unavailable.reason == "credits_absent"
    assert result.unavailable.notice == DARK_NOTICE
    assert result.claims == []
    # Deterministic metadata still present for the UI.
    assert result.entity_id == "US:AAPL"
    assert result.day == "2026-08-30"
    # Dark results are NOT cached -- activation must be instant.
    assert list(tmp_path.iterdir()) == []


def test_briefing_validates_citations_and_caches(tmp_path):
    client = FakeAiClient([BRIEFING_REPLY])
    breaker = open_breaker()
    result = briefing_mod.build_briefing(
        "US:AAPL", client, breaker, str(tmp_path), entity_name="Apple Inc.", now=NOW
    )
    assert result.status == "ok"
    assert not result.cache_hit
    assert [c.claim for c in result.claims] == [
        "Announced a new plant in Cluj.",
        "CEO stepped down.",
    ]
    assert result.dropped_claim_count == 3
    assert result.sources == [
        "https://news.example.com/plant",
        "https://news.example.com/ceo",
    ]
    assert result.updated_at is not None
    assert client.calls[0]["want_web_search"] is True
    # Every served claim carries its citation pair.
    for claim in result.claims:
        assert claim.source_url.startswith("https://")
        datetime.date.fromisoformat(claim.article_date)

    # Second call same (entity, day): cache hit, model NOT re-billed.
    again = briefing_mod.build_briefing(
        "US:AAPL", client, breaker, str(tmp_path), now=NOW
    )
    assert again.status == "ok"
    assert again.cache_hit
    assert len(client.calls) == 1
    assert [c.claim for c in again.claims] == [c.claim for c in result.claims]
    assert again.dropped_claim_count == 3


def test_briefing_invalid_model_output_refused_not_cached(tmp_path):
    client = FakeAiClient(["I could not find anything relevant, sorry."])
    result = briefing_mod.build_briefing(
        "US:AAPL", client, open_breaker(), str(tmp_path), now=NOW
    )
    assert result.status == "unavailable"
    assert result.unavailable.reason == "model_output_invalid"
    assert list(tmp_path.iterdir()) == []


def test_briefing_budget_refusal(tmp_path):
    breaker = LocalSpendCounter(caps={"pm_briefing": 1}, env={})
    client = FakeAiClient([BRIEFING_REPLY])
    day1 = briefing_mod.build_briefing(
        "US:AAPL", client, breaker, str(tmp_path), now=NOW
    )
    assert day1.status == "ok"
    # New day -> cache miss -> breaker must refuse the second spend.
    day2 = briefing_mod.build_briefing(
        "US:AAPL", client, breaker, str(tmp_path),
        now=NOW + datetime.timedelta(days=1),
    )
    assert day2.status == "unavailable"
    assert day2.unavailable.reason == "budget_exhausted"
    assert len(client.calls) == 1  # the refused call never reached the model


# ---------------------------------------------------------------------------
# D2 filing reader
# ---------------------------------------------------------------------------

FACTS = {
    "revenue_fy2025": 413727560.0,
    "ebitda_fy2025": 54443834.0,
    "backlog_fy2025": None,  # present key, ABSENT value
}

SECTIONS = {
    "MD&A": "Revenue grew on volume; EBITDA followed. Backlog steady.",
    "Risk": "Raw material prices remain the main exposure.",
}

FILING_REPLY = json.dumps(
    {
        "sections": [
            {
                "section": "MD&A",
                "summary": "Management attributes growth to volume gains.",
                "figures": [
                    {  # matches facts -> served, matched
                        "label": "Revenue FY2025",
                        "fact_key": "revenue_fy2025",
                        "model_value": 413727560.0,
                    },
                    {  # disagrees with facts -> served AT facts value + flag
                        "label": "EBITDA FY2025",
                        "fact_key": "ebitda_fy2025",
                        "model_value": 99.0,
                    },
                    {  # key the facts do not carry -> dropped + flag
                        "label": "EPS FY2025",
                        "fact_key": "eps_fy2025",
                        "model_value": 3.14,
                    },
                    {  # key present but value absent -> dropped + flag
                        "label": "Backlog FY2025",
                        "fact_key": "backlog_fy2025",
                        "model_value": 12345.0,
                    },
                ],
            },
            {
                "section": "Risk",
                "summary": "Commodity exposure dominates the risk narrative.",
                "figures": [],
            },
            {  # section we never provided -> dropped + flag
                "section": "Outlook",
                "summary": "Invented section.",
                "figures": [],
            },
        ]
    }
)


def test_filing_reader_echoes_numbers_from_facts(tmp_path):
    client = FakeAiClient([FILING_REPLY])
    result = filing_mod.read_filing_brief(
        "0000320193-26-000010", SECTIONS, FACTS, client, open_breaker(),
        str(tmp_path), now=NOW,
    )
    assert result.status == "ok"
    assert [s.section for s in result.sections] == ["MD&A", "Risk"]

    mda = result.sections[0]
    assert [f.fact_key for f in mda.figures] == ["revenue_fy2025", "ebitda_fy2025"]

    revenue = mda.figures[0]
    assert revenue.value == FACTS["revenue_fy2025"]
    assert revenue.matched is True

    # The mismatch: served value is the FACTS value, the model's claim is
    # preserved in the figure and in a flag -- never corrected silently.
    ebitda = mda.figures[1]
    assert ebitda.value == FACTS["ebitda_fy2025"]
    assert ebitda.model_claimed == 99.0
    assert ebitda.matched is False

    flag_types = sorted(f["type"] for f in result.flags)
    assert flag_types == [
        "fact_value_absent",
        "model_facts_mismatch",
        "unknown_fact_key",
        "unknown_section",
    ]
    mismatch = [f for f in result.flags if f["type"] == "model_facts_mismatch"][0]
    assert mismatch["disposition"] == "flagged_not_corrected"
    assert mismatch["model_claimed"] == 99.0
    assert mismatch["facts_value"] == FACTS["ebitda_fy2025"]

    # ABSENT != ZERO: the absent backlog fact was never echoed as a number.
    served_keys = [f.fact_key for s in result.sections for f in s.figures]
    assert "backlog_fy2025" not in served_keys
    assert all(f.value != 0.0 or f.fact_key in FACTS for s in result.sections
               for f in s.figures)


def test_filing_reader_cached_per_accession(tmp_path):
    client = FakeAiClient([FILING_REPLY])
    breaker = open_breaker()
    first = filing_mod.read_filing_brief(
        "0000320193-26-000010", SECTIONS, FACTS, client, breaker,
        str(tmp_path), now=NOW,
    )
    second = filing_mod.read_filing_brief(
        "0000320193-26-000010", SECTIONS, FACTS, client, breaker,
        str(tmp_path), now=NOW + datetime.timedelta(days=2),
    )
    assert first.status == "ok" and second.status == "ok"
    assert second.cache_hit
    assert len(client.calls) == 1
    assert [s.summary for s in second.sections] == [
        s.summary for s in first.sections
    ]


def test_filing_reader_dark(tmp_path):
    result = filing_mod.read_filing_brief(
        "0000320193-26-000010", SECTIONS, FACTS, DarkAiClient(), open_breaker(),
        str(tmp_path), now=NOW,
    )
    assert result.status == "unavailable"
    assert result.unavailable.reason == "credits_absent"
    assert result.sections == []
    assert result.accession == "0000320193-26-000010"
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# D3 sentinel
# ---------------------------------------------------------------------------

def _seed_entities():
    return [
        sentinel_mod.SeededEntity(
            entity_id="US:FRESH", source="edgar",
            cadence=sentinel_mod.SourceCadence(filing_days=90, price_days=7),
            last_filing_date="2026-08-25", last_price_date="2026-08-29",
        ),
        sentinel_mod.SeededEntity(
            entity_id="US:STALE", source="edgar",
            cadence=sentinel_mod.SourceCadence(price_days=7),
            last_price_date="2026-08-20",  # 10d old vs 7 -> stale, not persistent
        ),
        sentinel_mod.SeededEntity(
            entity_id="US:GONE", source="edgar",
            cadence=sentinel_mod.SourceCadence(filing_days=30),
            last_filing_date=None,  # never observed -> worst-case staleness
        ),
        sentinel_mod.SeededEntity(
            entity_id="DE:OLD", source="xbrl_org",
            cadence=sentinel_mod.SourceCadence(price_days=7),
            last_price_date="2026-08-01",  # 29d vs 7 -> stale AND persistent
        ),
    ]


def test_sentinel_assess_freshness_deterministic():
    assessments = sentinel_mod.assess_freshness(_seed_entities(), NOW)
    by_key = {(a.entity_id, a.kind): a for a in assessments}
    assert len(assessments) == 5

    assert by_key[("US:FRESH", "filing")].stale is False
    assert by_key[("US:FRESH", "price")].stale is False

    stale = by_key[("US:STALE", "price")]
    assert stale.stale is True and stale.persistent is False
    assert stale.age_days == 10

    # ABSENT != ZERO: no observation at all is the strongest staleness.
    gone = by_key[("US:GONE", "filing")]
    assert gone.stale is True and gone.persistent is True
    assert gone.reason == "never_seen"
    assert gone.age_days is None

    old = by_key[("DE:OLD", "price")]
    assert old.stale is True and old.persistent is True


def test_sentinel_queue_dedups_per_day(tmp_path):
    assessments = sentinel_mod.assess_freshness(_seed_entities(), NOW)
    queue = str(tmp_path / "obs" / "market_refetch_queue.jsonl")
    first = sentinel_mod.write_refetch_queue(assessments, queue, NOW)
    assert first == 3  # STALE price, GONE filing, OLD price
    again = sentinel_mod.write_refetch_queue(assessments, queue, NOW)
    assert again == 0  # same day -> fully deduped
    with open(queue, "r", encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    assert len(rows) == 3
    assert {r["entity_id"] for r in rows} == {"US:STALE", "US:GONE", "DE:OLD"}
    # Next day the still-stale entities queue again.
    tomorrow = NOW + datetime.timedelta(days=1)
    third = sentinel_mod.write_refetch_queue(
        sentinel_mod.assess_freshness(_seed_entities(), tomorrow), queue, tomorrow
    )
    assert third == 3


def test_sentinel_summary_record(tmp_path):
    assessments = sentinel_mod.assess_freshness(_seed_entities(), NOW)
    queue = str(tmp_path / "obs" / "market_refetch_queue.jsonl")
    queued = sentinel_mod.write_refetch_queue(assessments, queue, NOW)
    summary_path = str(tmp_path / "obs" / "market_freshness_last.json")
    summary = sentinel_mod.write_summary(
        assessments, summary_path, NOW, queue, queued, None
    )
    with open(summary_path, "r", encoding="utf-8") as fh:
        on_disk = json.load(fh)
    assert on_disk == summary
    assert on_disk["checks"] == 5
    assert on_disk["stale_count"] == 3
    assert on_disk["persistent_gap_count"] == 2
    assert {g["entity_id"] for g in on_disk["persistent_gaps"]} == {
        "US:GONE", "DE:OLD",
    }
    assert on_disk["ai_identity_review"]["status"] == "skipped"


def test_sentinel_identity_proposals_are_review_only(tmp_path):
    """Valid proposals land in the review queue; NOTHING else is written --
    identity is never auto-mutated (the review queue is the only output)."""
    entities = _seed_entities()
    gapped = [e for e in entities if e.entity_id in ("US:GONE", "DE:OLD")]
    reply = json.dumps(
        [
            {
                "entity_id": "US:GONE",
                "proposal_type": "delisting",
                "evidence_url": "https://exchange.example.com/notice",
                "note": "Delisted after merger completion.",
            },
            {  # unknown entity -> dropped, counted
                "entity_id": "US:NOT_IN_SCOPE",
                "proposal_type": "ticker_change",
                "evidence_url": "https://example.com/x",
                "note": "n/a",
            },
            {  # bad proposal type -> dropped, counted
                "entity_id": "DE:OLD",
                "proposal_type": "bankruptcy",
                "evidence_url": "https://example.com/y",
                "note": "n/a",
            },
        ]
    )
    client = FakeAiClient([reply])
    review = str(tmp_path / "obs" / "market_identity_review_queue.jsonl")
    before = snapshot_tree(str(tmp_path))
    outcome = sentinel_mod.propose_identity_review(
        gapped, client, open_breaker(), review, NOW
    )
    assert outcome.status == "ok"
    assert len(outcome.proposals) == 1
    assert outcome.dropped_proposal_count == 2
    assert outcome.proposals[0]["entity_id"] == "US:GONE"
    assert outcome.proposals[0]["status"] == "pending_review"

    after = snapshot_tree(str(tmp_path))
    created = set(after) - set(before)
    # The ONLY new file is the review queue; nothing pre-existing changed.
    assert created == {os.path.join("obs", "market_identity_review_queue.jsonl")}
    assert all(after[k] == v for k, v in before.items())
    with open(review, "r", encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    assert len(rows) == 1 and rows[0]["proposal_type"] == "delisting"


def test_sentinel_identity_dark_writes_nothing(tmp_path):
    gapped = [e for e in _seed_entities() if e.entity_id == "US:GONE"]
    review = str(tmp_path / "obs" / "review.jsonl")
    outcome = sentinel_mod.propose_identity_review(
        gapped, DarkAiClient(), open_breaker(), review, NOW
    )
    assert outcome.status == "unavailable"
    assert outcome.unavailable.reason == "credits_absent"
    assert outcome.proposals == []
    assert not os.path.exists(review)


def test_sentinel_load_seed_fails_closed(tmp_path):
    good = tmp_path / "seed.json"
    good.write_text(
        json.dumps(
            [
                {
                    "entity_id": "US:AAPL",
                    "source": "edgar",
                    "cadence": {"filing_days": 90, "price_days": 7},
                    "last_filing_date": "2026-08-01",
                    "last_price_date": None,
                }
            ]
        ),
        encoding="utf-8",
    )
    entities = sentinel_mod.load_seed(str(good))
    assert len(entities) == 1
    assert entities[0].cadence.filing_days == 90
    assert entities[0].last_price_date is None

    bad = tmp_path / "bad.json"
    bad.write_text(
        json.dumps([{"entity_id": "US:AAPL", "source": "edgar",
                     "cadence": {"filing_days": "quarterly"}}]),
        encoding="utf-8",
    )
    with pytest.raises(sentinel_mod.SeedFormatError):
        sentinel_mod.load_seed(str(bad))

    dup = tmp_path / "dup.json"
    dup.write_text(
        json.dumps([
            {"entity_id": "US:AAPL", "source": "edgar", "cadence": {}},
            {"entity_id": "US:AAPL", "source": "edgar", "cadence": {}},
        ]),
        encoding="utf-8",
    )
    with pytest.raises(sentinel_mod.SeedFormatError):
        sentinel_mod.load_seed(str(dup))


# ---------------------------------------------------------------------------
# D4 peers
# ---------------------------------------------------------------------------

SUBJECT = peers_mod.PeerCandidate(
    ticker="SCND", name="Scandia Food", sector="Food", size_value=500e6
)
UNIVERSE = [
    peers_mod.PeerCandidate("A-FOOD", "Alpha Foods", "Food", 600e6),
    peers_mod.PeerCandidate("F-FOOD", "Foxtrot Foods", "Food", 600e6),
    peers_mod.PeerCandidate("B-FOOD", "Bravo Foods", "food", 4e9),
    peers_mod.PeerCandidate("C-FOOD", "Micro Foods", "Food", 10e6),  # other band
    peers_mod.PeerCandidate("D-TECH", "Delta Tech", "Tech", 700e6),  # other sector
    peers_mod.PeerCandidate("E-FOOD", "Echo Foods", "Food", None),   # size absent
    peers_mod.PeerCandidate("SCND", "Scandia Food", "Food", 500e6),  # self
]


def test_size_band_absent_is_not_micro():
    assert peers_mod.size_band(None) is None  # ABSENT != ZERO
    assert peers_mod.size_band(10e6) == "micro"
    assert peers_mod.size_band(500e6) == "mid"
    assert peers_mod.size_band(-5.0) is None


def test_deterministic_peers_sector_band_ordering():
    det = peers_mod.deterministic_peers(SUBJECT, UNIVERSE)
    assert det["basis"] == "sector_size_band"
    # size proximity first, ticker A->Z as tiebreak; self/other-band/other-
    # sector/absent-size all excluded.
    assert [c.ticker for c in det["peers"]] == ["A-FOOD", "F-FOOD", "B-FOOD"]
    # Determinism: same call, same answer.
    again = peers_mod.deterministic_peers(SUBJECT, UNIVERSE)
    assert [c.ticker for c in again["peers"]] == ["A-FOOD", "F-FOOD", "B-FOOD"]


def test_deterministic_peers_subject_size_absent():
    subject = peers_mod.PeerCandidate("SCND", "Scandia Food", "Food", None)
    det = peers_mod.deterministic_peers(subject, UNIVERSE)
    assert det["basis"] == "sector_only_size_absent"
    assert [c.ticker for c in det["peers"]] == [
        "A-FOOD", "B-FOOD", "C-FOOD", "E-FOOD", "F-FOOD",
    ]


def test_rank_peers_dark_keeps_standard_ordering():
    result = peers_mod.rank_peers(
        SUBJECT, UNIVERSE, DarkAiClient(), open_breaker()
    )
    assert [c.ticker for c in result.peers] == ["A-FOOD", "F-FOOD", "B-FOOD"]
    assert result.ordering == "standard"
    assert result.ordering_label == "standard ordering"
    assert result.rationales == {}
    assert result.unavailable is not None
    assert result.unavailable.reason == "credits_absent"


def test_rank_peers_ai_reorders_same_set():
    reply = json.dumps(
        [
            {"ticker": "B-FOOD", "rationale": "Closest product mix."},
            {"ticker": "A-FOOD", "rationale": "Same region, smaller."},
            {"ticker": "F-FOOD", "rationale": "Diversified but comparable."},
        ]
    )
    result = peers_mod.rank_peers(
        SUBJECT, UNIVERSE, FakeAiClient([reply]), open_breaker()
    )
    assert result.ordering == "ai_ranked"
    assert [c.ticker for c in result.peers] == ["B-FOOD", "A-FOOD", "F-FOOD"]
    assert result.rationales["B-FOOD"] == "Closest product mix."
    assert result.flags == []


def test_rank_peers_rejects_non_permutation():
    # The model tries to ADD a ticker -> membership is not an AI decision.
    reply = json.dumps(
        [
            {"ticker": "B-FOOD", "rationale": "x"},
            {"ticker": "A-FOOD", "rationale": "x"},
            {"ticker": "F-FOOD", "rationale": "x"},
            {"ticker": "ZZ-NEW", "rationale": "invented"},
        ]
    )
    result = peers_mod.rank_peers(
        SUBJECT, UNIVERSE, FakeAiClient([reply]), open_breaker()
    )
    assert result.ordering == "standard"
    assert [c.ticker for c in result.peers] == ["A-FOOD", "F-FOOD", "B-FOOD"]
    assert any(f["type"] == "ai_rank_invalid" for f in result.flags)

    # ...and to DROP one -> same refusal.
    reply2 = json.dumps([{"ticker": "B-FOOD", "rationale": "x"}])
    result2 = peers_mod.rank_peers(
        SUBJECT, UNIVERSE, FakeAiClient([reply2]), open_breaker()
    )
    assert result2.ordering == "standard"
    assert [c.ticker for c in result2.peers] == ["A-FOOD", "F-FOOD", "B-FOOD"]


# ---------------------------------------------------------------------------
# D5 budget
# ---------------------------------------------------------------------------

def test_local_spend_counter_caps_per_role():
    counter = LocalSpendCounter(caps={"pm_briefing": 2}, env={})
    assert counter.allow("pm_briefing") is None
    counter.record("pm_briefing")
    assert counter.allow("pm_briefing") is None
    counter.record("pm_briefing")
    refusal = counter.allow("pm_briefing")
    assert isinstance(refusal, AiUnavailable)
    assert refusal.reason == "budget_exhausted"
    # Other roles are unaffected (caps are PER ROLE).
    assert counter.allow("pm_peers") is None


def test_local_spend_counter_env_caps():
    env = {"PM_AI_CALL_CAP": "1", "PM_AI_CALL_CAP_PM_PEERS": "3"}
    counter = LocalSpendCounter(env=env)
    counter.record("pm_briefing")
    assert counter.allow("pm_briefing").reason == "budget_exhausted"
    counter.record("pm_peers")
    assert counter.allow("pm_peers") is None  # per-role override wins


def test_resolve_spend_breaker_reports_backend():
    from engine.public_market.freshness import resolve_spend_breaker

    breaker = resolve_spend_breaker(env={})
    # Whichever backend resolved, it exposes the contract + its identity.
    assert breaker.backend in ("engine.ai", "local_counter")
    assert breaker.allow("pm_briefing") is None or isinstance(
        breaker.allow("pm_briefing"), AiUnavailable
    )


# ---------------------------------------------------------------------------
# Operator CLI (subprocess, dark env)
# ---------------------------------------------------------------------------

SCRIPT = os.path.join(_REPO_ROOT, "scripts", "public_market_sentinel.py")


def _dark_env():
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    return env


def _write_cli_seed(tmp_path):
    seed = tmp_path / "seed.json"
    seed.write_text(
        json.dumps(
            [
                {
                    "entity_id": "US:FRESH", "source": "edgar",
                    "cadence": {"filing_days": 90},
                    "last_filing_date": "2026-08-25",
                },
                {
                    "entity_id": "US:GONE", "source": "edgar",
                    "cadence": {"filing_days": 30},
                    "last_filing_date": None,
                },
            ]
        ),
        encoding="utf-8",
    )
    return str(seed)


def test_cli_end_to_end_dark(tmp_path):
    seed = _write_cli_seed(tmp_path)
    data_dir = str(tmp_path / "data")
    proc = subprocess.run(
        [
            sys.executable, SCRIPT,
            "--seed", seed,
            "--now", "2026-08-30T12:00:00+00:00",
            "--data-dir", data_dir,
            "--propose-identity",
            "--json",
        ],
        capture_output=True, text=True, env=_dark_env(),
    )
    assert proc.returncode == 0, proc.stderr
    summary = json.loads(proc.stdout)
    assert summary["checks"] == 2
    assert summary["stale_count"] == 1
    assert summary["persistent_gap_count"] == 1
    # Dark AI: calm typed notice, deterministic output complete anyway.
    assert summary["ai_identity_review"]["status"] == "unavailable"
    assert (
        summary["ai_identity_review"]["unavailable"]["reason"] == "credits_absent"
    )
    summary_path = os.path.join(data_dir, "obs", "market_freshness_last.json")
    queue_path = os.path.join(data_dir, "obs", "market_refetch_queue.jsonl")
    assert os.path.exists(summary_path)
    assert os.path.exists(queue_path)
    review_path = os.path.join(
        data_dir, "obs", "market_identity_review_queue.jsonl"
    )
    assert not os.path.exists(review_path)  # dark -> proposals never written


def test_cli_refuses_malformed_seed(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("[{\"entity_id\": 42}]", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, SCRIPT, "--seed", str(bad),
         "--data-dir", str(tmp_path / "data")],
        capture_output=True, text=True, env=_dark_env(),
    )
    assert proc.returncode == 2
    assert proc.stderr.startswith("SEED_REFUSED:")
    # Fail closed: a refused seed writes nothing at all.
    assert not os.path.exists(str(tmp_path / "data"))


def test_cli_dry_run_writes_nothing(tmp_path):
    seed = _write_cli_seed(tmp_path)
    data_dir = str(tmp_path / "data")
    proc = subprocess.run(
        [sys.executable, SCRIPT, "--seed", seed,
         "--now", "2026-08-30T12:00:00+00:00",
         "--data-dir", data_dir, "--dry-run", "--json"],
        capture_output=True, text=True, env=_dark_env(),
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["dry_run"] is True
    assert not os.path.exists(data_dir)
