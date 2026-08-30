# -*- coding: utf-8 -*-
"""PM1-PM7 — the gate lane. Every gate here is PROVEN by a plant.

WHAT THIS FILE IS FOR
=====================
``scripts/check_public_market_gates.py`` holds the checks. This file
holds the PROOF that each one can fail. A gate nobody has ever seen fail
is not a gate — it is a green light wired to nothing, and this codebase
has already paid for one of those (public_ro shipped 244 green tests and
a 19-gate battery while every hub page returned 500).

So for each PM there is:

  · a PLANT   — a deliberate violation, fed to the real check, asserted
                to trip, and reverted inside the test;
  · a CLEAN   — the real tree / the real objects, asserted to pass;
  · a NON-VACUITY note where the honest state today is "cannot fail yet"
    (PM2), so nobody mistakes an empty scan for a proven one.

The plants never mutate the repository. Where a plant needs a poisoned
module, the package is copied to a temp tree and the copy is poisoned:
an in-place plant interrupted by Ctrl-C or a killed CI job leaves a
corrupted engine file on disk, and the bytes scanned are identical
either way.

There is deliberately NO fake store, NO mirror registry and NO
re-derived market table in this file. Envelopes are built from the
committed REAL SEC bytes through the real adapter; the store is the real
sqlite store on a temp path; the router is the real FastAPI router.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))


def _load_gates():
    """Load the gate script as a module. It lives in scripts/ (it is an
    operator entry point first), so it is loaded by path rather than
    imported — the same trick tests/engine/conftest.py uses for the
    fixture generator."""
    path = REPO / "scripts" / "check_public_market_gates.py"
    cached = sys.modules.get("public_market_gates")
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location("public_market_gates", str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules["public_market_gates"] = module
    spec.loader.exec_module(module)
    return module


G = _load_gates()

PACKAGE_DIR = REPO / "src" / "engine" / "public_market"


# ══════════════════════════════════════════════════════════════════════
# Plant harness
# ══════════════════════════════════════════════════════════════════════


class PlantedTree(object):
    """A throwaway copy of the real package, with one file poisoned.

    ``__exit__`` deletes the whole copy — the revert is total by
    construction, not by remembering to undo an edit.
    """

    def __init__(self, relative_path, appended_source):
        self.relative_path = relative_path
        self.appended_source = appended_source
        self._tmp = None
        self.root = None

    def __enter__(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="pm-plant-"))
        self.root = self._tmp / "public_market"
        shutil.copytree(PACKAGE_DIR, self.root)
        victim = self.root / self.relative_path
        victim.write_text(
            victim.read_text(encoding="utf-8") + "\n" + self.appended_source,
            encoding="utf-8",
        )
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self._tmp, ignore_errors=True)
        return False


def assert_reverted():
    """After any plant, the real tree must still scan clean on every
    scanner. Cheap, and it catches a plant that leaked."""
    assert G.scan_numeric_path_ai_imports() == []
    assert G.scan_freshness_write_surface() == []
    assert G.scan_public_ro_coupling() == []


# ══════════════════════════════════════════════════════════════════════
# PM1 — no AI-authored numerics in the facts path
# ══════════════════════════════════════════════════════════════════════


def test_pm1_clean_on_the_real_tree():
    assert G.scan_numeric_path_ai_imports() == []
    assert G.scan_freshness_write_surface() == []


def test_pm1_plant_model_sdk_import_into_the_facts_path():
    """PLANT: a deterministic module reaches a model SDK. Reverted by
    dropping the temp tree."""
    with PlantedTree("model.py", "import anthropic  # PLANT\n") as planted:
        hits = G.scan_numeric_path_ai_imports(planted.root)
    assert hits, "the facts-path scan did not trip on 'import anthropic'"
    assert any("model.py" in h and "anthropic" in h for h in hits), hits
    assert_reverted()


def test_pm1_plant_ai_layer_import_into_the_facts_path():
    """PLANT: reaching the AI layer from a numeric module — the same
    failure one indirection later."""
    with PlantedTree(
        "store.py",
        "from engine.public_market.freshness import briefing  # PLANT\n",
    ) as planted:
        hits = G.scan_numeric_path_ai_imports(planted.root)
    assert any("store.py" in h and "freshness" in h for h in hits), hits
    assert_reverted()


def test_pm1_plant_freshness_reaching_a_store_write_api():
    """PLANT: the AI layer imports the spine store. R1 says AI output can
    never mutate what the deterministic spine produced; the import is the
    capability, and the capability is what the gate removes."""
    with PlantedTree(
        "freshness/sentinel.py",
        "from engine.public_market.store import get_store  # PLANT\n",
    ) as planted:
        hits = G.scan_freshness_write_surface(planted.root / "freshness")
    assert hits, "the freshness write-surface scan did not trip"
    assert any("sentinel.py" in h for h in hits), hits
    assert_reverted()


def test_pm1_plant_freshness_mutation_token():
    """PLANT: a dynamically-built write. The token scan exists precisely
    because ``getattr(store, 'put_' + kind)`` has no import to catch."""
    with PlantedTree(
        "freshness/peers.py",
        "_PLANT = 'put_filing'  # PLANT: dynamic dispatch to a write API\n",
    ) as planted:
        hits = G.scan_freshness_write_surface(planted.root / "freshness")
    assert any("put_filing" in h for h in hits), hits
    assert_reverted()


def test_pm1_reference_envelope_is_deterministically_sourced():
    """CLEAN: a REAL envelope, built from committed SEC bytes through the
    real adapter, carries a deterministic source on every figure."""
    envelope = G.build_reference_envelope()
    assert envelope["figures"], "the reference envelope carries no figures"
    assert G.assert_no_model_authored_figures(envelope) == []


def test_pm1_plant_model_authored_revenue_is_refused():
    """THE HEADLINE PLANT: a model writes a revenue into an otherwise
    real envelope.

    Two separate facts are asserted, and they are NOT the same fact:

      1. the GATE refuses it (this is PM1's runtime guard, and it is the
         thing that must hold);
      2. the SPINE's own validator does NOT — ``model.validate_envelope``
         returns clean and ``store.put_filing`` persists it, so a
         fabricated figure would be served today.

    (2) is asserted deliberately rather than left implicit: the day the
    spine lane closes that hole, this assertion fails loudly and the
    person closing it deletes it. A silent "we'll remember" is how a gap
    survives a wave.
    """
    from engine.public_market import model as model_mod

    envelope = G.build_reference_envelope()
    planted = copy.deepcopy(envelope)
    planted.pop("content_hash")
    figures = dict(planted["figures"])
    fabricated = dict(figures["revenue"])
    fabricated["value_minor"] = 42424242
    fabricated["provenance"] = {
        "source": "claude-fable-5",
        "accession_or_version": "llm-1",
        "as_of": "2025-09-27",
        "fetched_at": "2026-08-29T00:00:00+00:00",
    }
    figures["revenue"] = fabricated
    planted["figures"] = figures
    planted = model_mod.stamp_content_hash(planted)

    # 1. the gate refuses.
    hits = G.assert_no_model_authored_figures(planted, "planted")
    assert hits, "PM1's runtime guard accepted a model-authored revenue"
    assert any("claude-fable-5" in h for h in hits), hits

    # 2. the spine, today, does not. Documented, not hidden.
    assert model_mod.validate_envelope(planted) == [], (
        "model.validate_envelope now rejects an AI-sourced provenance — the "
        "PM1 gap is CLOSED. Delete this assertion and the note in "
        "design_review/markets/GATES.md."
    )


def test_pm1_plant_figure_with_no_provenance_is_refused_everywhere():
    """PLANT: a number with nobody's name on it. Unlike the AI-source
    plant above, this one IS already refused end to end — by the gate,
    by pm1 validation, and by the store."""
    from engine.public_market import model as model_mod
    from engine.public_market.store import StoreError

    planted = copy.deepcopy(G.build_reference_envelope())
    planted.pop("content_hash")
    figures = dict(planted["figures"])
    figures["revenue"] = {"value_minor": 999, "currency": "USD"}
    planted["figures"] = figures
    planted = model_mod.stamp_content_hash(planted)

    assert G.assert_no_model_authored_figures(planted, "planted")
    assert any("provenance" in p for p in model_mod.validate_envelope(planted))
    with G._temp_store() as store:
        with pytest.raises(StoreError):
            store.put_filing(planted)


def test_pm1_source_denylist_is_not_a_whitelist_in_disguise():
    """A missing / blank source is model-authored by default: fail
    closed. And a real feed name passes, so the denylist has not been
    widened into 'refuse everything'."""
    assert G.source_is_model_authored(None)
    assert G.source_is_model_authored("")
    assert G.source_is_model_authored("   ")
    assert G.source_is_model_authored("provider:mock")
    assert G.source_is_model_authored("claude-fable-6")
    assert not G.source_is_model_authored("sec_edgar_companyfacts")
    assert not G.source_is_model_authored("filings.xbrl.org")
    assert not G.source_is_model_authored("provider:eodhd")


def test_pm1_gate_verdict_is_green():
    result = G.check_pm1()
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# PM2 — no cross-standard / cross-market percentile blending
# ══════════════════════════════════════════════════════════════════════


def _blending_grouper(universe):
    """PLANT: the grouper this gate exists to forbid — one cohort, two
    accounting standards, four markets, because they share a sector."""
    return {"technology": list(universe)}


def _segregating_grouper(universe):
    """The control: one cohort per (market, standard)."""
    groups = {}
    for row in universe:
        key = "%s/%s" % (row["market_id"], row["accounting_standard"])
        groups.setdefault(key, []).append(row)
    return groups


def test_pm2_plant_blending_grouper_trips_the_partition_contract():
    hits = G.check_group_partition(_blending_grouper(G._mixed_cohort_universe()))
    assert hits, "the partition contract accepted a US-GAAP + IFRS cohort"
    assert any("accounting_standard" in h for h in hits), hits
    assert any("market_id" in h for h in hits), hits


def test_pm2_segregating_grouper_passes():
    assert G.check_group_partition(
        _segregating_grouper(G._mixed_cohort_universe())) == []


def test_pm2_plant_unlabeled_member_trips():
    """A row that declares neither market nor standard can be blended
    into ANY cohort — so an unlabeled row is itself a violation, not a
    row the check quietly skips."""
    hits = G.check_group_partition({"g": [{"ticker": "???", "revenue_minor": 1}]})
    assert any("declare neither" in h for h in hits), hits


def test_pm2_plant_market_blind_cohort_statistic_trips():
    """PLANT: a module computes a median with no idea which market the
    rows come from. This arms BEFORE any grouping function exists."""
    with PlantedTree(
        "esef.py",
        "import statistics\n"
        "def _plant(rows):\n"
        "    return statistics.median([r for r in rows])\n",
    ) as planted:
        hits = G.scan_cohort_statistics(planted.root)
    assert any("esef.py" in h and "median" in h for h in hits), hits
    assert_reverted()


def test_pm2_real_package_computes_no_market_blind_statistic():
    assert G.scan_cohort_statistics() == []


def test_pm2_is_honestly_skipped_while_no_engine_cohort_exists():
    """NON-VACUITY, stated out loud.

    Nothing server-side computes a cohort statistic today, so PM2's
    engine half CANNOT fail — and the gate reports SKIP, never PASS. The
    note must also say WHERE the live contract actually is, or a reader
    would take the skip for "unenforced". If this test starts failing
    because an engine seam appeared, that is the whole point: PM2 then
    goes green or red on real server-side code.
    """
    fn, seam = G.discover_grouping_fn()
    result = G.check_pm2()
    if fn is not None:  # pragma: no cover — arms when an engine seam lands
        assert result.state == G.PASS, (seam, result.violations)
        return
    assert result.state == G.SKIP
    assert any(G.FRONTEND_GROUPING_SEAM in n for n in result.notes), result.notes
    assert any("arms itself" in n for n in result.notes), result.notes


def test_pm2_grouping_law_exists_on_the_frontend():
    """PM2 is not unenforced — it is enforced ELSEWHERE, and this pins
    where. The benchmark lane shipped on the frontend, so a cohort is
    formed from display snapshots and the grouping law lives with them.
    If that module loses its exports, PM2 is silently measuring nothing,
    and the gate says so."""
    landed, missing = G.frontend_grouping_state()
    assert landed, (
        "%s is gone — PM2's only live implementation went with it"
        % G.FRONTEND_GROUPING_SEAM)
    assert missing == [], missing


@pytest.mark.skipif(
    G.discover_grouping_fn()[0] is None,
    reason=(
        "LOUD SKIP — PM2's ENGINE-side contract. No engine seam in "
        "scripts/check_public_market_gates.py::GROUPING_FN_SEAMS resolves, "
        "because the benchmark lane shipped on the FRONTEND "
        "(frontend/lib/benchmarkGroups.ts) where the live contract IS "
        "asserted, by frontend/lib/__tests__/marketGates.test.ts and "
        "benchmarkHonesty.test.ts. Nothing server-side computes a cohort "
        "statistic, so there is nothing here to blend. The engine-side "
        "contract is proven above against a planted blending grouper and "
        "arms itself the moment a percentile moves onto the engine."
    ),
)
def test_pm2_benchmark_lane_grouping_fn_partitions_by_market_and_standard():
    fn, seam = G.discover_grouping_fn()
    groups = fn(G._mixed_cohort_universe())
    assert G.check_group_partition(groups) == [], seam
    assert G._group_count(groups) >= 2, (
        "%s collapsed a two-standard universe into one group" % seam)


# ══════════════════════════════════════════════════════════════════════
# PM3 — small-n honesty states
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("n", [0, 1, 2])
def test_pm3_market_list_renders_every_market_at_small_n(n):
    """n = 0 / 1 / 2 through the REAL store and the REAL router: every
    market still renders, and the count is exact."""
    from engine.public_market import registry as registry_mod

    with G._temp_store() as store:
        us = registry_mod.get_market("us")
        G._seed_entities(store, us, n)
        payload = G._registry_payload_via_router(store)
        assert G.check_registry_small_n(payload, {"us": n}) == []
        entry = [e for e in payload["markets"] if e["market_id"] == "us"][0]
        assert entry["entities_held"] == n


def test_pm3_plant_a_market_that_vanishes_at_small_n():
    """PLANT: the tab disappears when the market holds nothing. A market
    that only appears once it has data can never show a reader that the
    gap exists."""
    from engine.public_market import registry as registry_mod

    full = registry_mod.registry_payload()
    for entry in full["markets"]:
        entry["entities_held"] = 0
    pruned = dict(full)
    pruned["markets"] = [e for e in full["markets"] if e["market_id"] != "de"]
    hits = G.check_registry_small_n(pruned, {})
    assert any("disappeared" in h and "'de'" in h for h in hits), hits


def test_pm3_plant_a_smoothed_count():
    """PLANT: n=1 reported as 'some'. An inexact small n is a rounded
    lie about how much evidence there is."""
    from engine.public_market import registry as registry_mod

    payload = registry_mod.registry_payload()
    for entry in payload["markets"]:
        entry["entities_held"] = 5 if entry["market_id"] == "us" else 0
    hits = G.check_registry_small_n(payload, {"us": 1})
    assert any("entities_held=5" in h for h in hits), hits


def test_pm3_plant_a_blank_market_label():
    from engine.public_market import registry as registry_mod

    payload = registry_mod.registry_payload()
    for entry in payload["markets"]:
        entry["entities_held"] = 0
        if entry["market_id"] == "fr":
            entry["display_name"] = ""
    hits = G.check_registry_small_n(payload, {})
    assert any("no display name" in h for h in hits), hits


@pytest.mark.parametrize("n", [0, 1, 2])
def test_pm3_plant_a_statistic_over_a_short_cohort(n):
    """PLANT: a percentile over one or two companies. Below n=3 the
    number describes the members, not a market."""
    members = list(range(n))
    assert G.check_small_n_cohort(members, statistic=12.5), n
    assert G.check_small_n_cohort(members, statistic=None) == []


def test_pm3_cohort_threshold_releases_at_n3():
    """Non-vacuity in the other direction: the check must not simply
    refuse every statistic."""
    assert G.check_small_n_cohort([1, 2, 3], statistic=12.5) == []


@pytest.mark.parametrize("n", [1, 2])
def test_pm3_peer_selection_stays_short_at_small_n(n):
    """The one cohort selector shipping today, at n=1 and n=2: it must
    return exactly what exists, labeled, and never pad."""
    from engine.public_market.freshness.peers import (
        PeerCandidate, deterministic_peers,
    )

    subject = PeerCandidate("AAPL", "Apple Inc", "Technology", 3.0e12)
    universe = [PeerCandidate("P%d" % i, "Peer %d" % i, "Technology", 3.0e12)
                for i in range(n)]
    result = deterministic_peers(subject, universe)
    assert len(result["peers"]) == n
    assert result["basis"]


def test_pm3_gate_verdict_is_green():
    result = G.check_pm3()
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# PM4 — stale / delayed prices are ALWAYS labeled
# ══════════════════════════════════════════════════════════════════════

NOW = "2026-08-29T12:00:00+00:00"
THREE_DAYS_OLD = "2026-08-26"
SIX_DAYS_OLD = "2026-08-22"


def test_pm4_plant_unlabeled_three_day_old_price():
    """THE BRIEFED PLANT: a three-day-old price with no delay label.

    Three days is INSIDE the EOD freshness budget — which is exactly why
    this is the dangerous case. It is not stale, so no staleness flag
    would fire; the only thing standing between the reader and a number
    that looks live is the label. Planted here, it must fail.
    """
    unlabeled = {"symbol": "AAPL", "value": 232.14, "currency": "USD",
                 "as_of": THREE_DAYS_OLD}
    hits = G.check_price_labeled(unlabeled, "eod", now=NOW)
    assert hits, "an unlabeled 3-day-old price was accepted"
    assert any("delay_note" in h for h in hits), hits

    # REVERT: label it through the real code path and it passes.
    from engine.public_market import prices as prices_mod

    labeled = prices_mod.label_quote(dict(unlabeled), "US", now=NOW)
    assert G.check_price_labeled(labeled, "eod", now=NOW) == []
    assert labeled["stale"] is False, "3 days is inside the 5-day EOD budget"


def test_pm4_plant_undateable_price():
    hits = G.check_price_labeled({"value": 1.0, "delay_note": "x"}, "eod", now=NOW)
    assert any("as_of" in h for h in hits), hits


def test_pm4_plant_stale_price_that_is_not_flagged():
    """PLANT: a six-day-old close carrying a delay note but no stale
    flag. Labeled, and still lying."""
    sneaky = {"symbol": "AAPL", "value": 232.14, "currency": "USD",
              "as_of": SIX_DAYS_OLD, "delay_note": "End-of-day close",
              "stale": False}
    hits = G.check_price_labeled(sneaky, "eod", now=NOW)
    assert any("not flagged stale" in h for h in hits), hits


def test_pm4_real_labeler_flags_a_six_day_old_close():
    from engine.public_market import prices as prices_mod

    labeled = prices_mod.label_quote(
        {"symbol": "AAPL", "value": 1.0, "as_of": SIX_DAYS_OLD}, "US", now=NOW)
    assert labeled["stale"] is True
    assert G.check_price_labeled(labeled, "eod", now=NOW) == []


def test_pm4_real_labeler_refuses_an_undateable_quote():
    from engine.public_market._refusal import Refusal
    from engine.public_market import prices as prices_mod

    refusal = prices_mod.label_quote({"symbol": "AAPL", "value": 1.0},
                                     "US", now=NOW)
    assert isinstance(refusal, Refusal)
    assert refusal.code == "price_missing_as_of"


def test_pm4_plant_unlabeled_price_block_is_refused_by_the_envelope():
    """The same plant one layer up: pm1 validation and the store both
    refuse a price block with no delay_note."""
    from engine.public_market.store import StoreError
    from engine.public_market import model as model_mod

    planted = G._with_price(G.build_reference_envelope(), {
        "price_minor": 23214, "currency": "USD", "as_of": THREE_DAYS_OLD,
    })
    assert any("delay_note" in p for p in model_mod.validate_envelope(planted))
    with G._temp_store() as store:
        with pytest.raises(StoreError):
            store.put_filing(planted)


def test_pm4_presenter_never_leaves_the_price_line_blank():
    """No price at all is a POLICY, and it has to read as one. A blank
    slot reads as a loading state."""
    from engine.serving import present_public_market

    presented = present_public_market(G.build_reference_envelope())
    assert presented is not None
    assert presented["price_line_en"].strip()
    assert presented["price_line_ro"].strip()
    assert presented["delay_note"] is None


def test_pm4_presenter_surfaces_the_delay_note_verbatim():
    from engine.public_market import prices as prices_mod
    from engine.serving import present_public_market

    note = prices_mod.delay_note_for("US")
    priced = G._with_price(G.build_reference_envelope(), {
        "price_minor": 23214, "currency": "USD", "as_of": THREE_DAYS_OLD,
        "delay_note": note,
    })
    presented = present_public_market(priced)
    assert presented["delay_note"] == note
    assert presented["price_line_en"] == note


def test_pm4_gate_verdict_is_green():
    result = G.check_pm4()
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# PM5 — keyless resilience
# ══════════════════════════════════════════════════════════════════════


def test_pm5_network_trap_is_not_decoration():
    """PLANT: attempt the network inside the trap. If this passes
    silently, every 'no network was attempted' assertion below is
    worthless."""
    with G._NoNetwork() as trap:
        with pytest.raises(G.NetworkAttempted):
            import urllib.request

            urllib.request.urlopen("https://eodhd.com/api/eod/AAPL")
    assert trap.attempts
    # REVERT is automatic: __exit__ restores every hook. Prove it.
    import urllib.request
    import socket as socket_mod

    assert urllib.request.urlopen.__module__.startswith("urllib")
    assert socket_mod.getaddrinfo.__module__ in ("socket", "_socket")


def test_pm5_plant_a_live_key_would_reach_the_wire():
    """PLANT: with a key present the slot goes live and the licensed
    path DOES try to fetch — which is what makes 'keyless attempts
    nothing' a real claim rather than a tautology about dead code.

    The trap's exception does NOT propagate here, and that is correct:
    ``LicensedProvider._get_json`` catches every boundary failure and
    converts it into a typed ``Refusal`` (fail closed, never a partial
    number). So the proof is the trap's own ATTEMPT LOG, not a raise —
    and the refusal that comes back is asserted too, because a provider
    that swallowed a transport error into ``None`` would be its own bug.
    """
    from engine.public_market._refusal import Refusal
    from engine.public_market import prices as prices_mod
    from engine.public_market import providers as providers_mod

    keyed = {"PROVIDER_API_KEY": "plant-key"}
    assert providers_mod.provider_is_live(providers_mod.provider_from_env(keyed))
    with G._NoNetwork() as trap:
        result = prices_mod.price_block("AAPL", "US", env=keyed)
    assert trap.attempts, (
        "a KEYED provider slot reached no egress path — the trap is watching "
        "the wrong hooks, and every 'keyless sent nothing' assertion above "
        "would be vacuous"
    )
    assert isinstance(result, Refusal), result
    assert "plant-key" not in result.detail, "the API key leaked into a refusal"


def test_pm5_keyless_provider_never_reports_live():
    from engine.public_market import providers as providers_mod

    for env in ({}, {"PROVIDER_API_KEY": ""}, {"PROVIDER_API_KEY": "  "}):
        assert not providers_mod.provider_is_live(
            providers_mod.provider_from_env(env))


def test_pm5_keyless_price_block_is_absent_not_zero():
    """The designed absence. None — never 0.0, never a mock quote, never
    a null-ish placeholder that a renderer would format as a price."""
    from engine.public_market import prices as prices_mod

    with G._NoNetwork() as trap:
        for market in ("US", "DE", "FR", "IT", "ES", "AE"):
            assert prices_mod.price_block("AAPL", market, env={}) is None
    assert trap.attempts == []


def test_pm5_mock_quote_never_reaches_a_served_block():
    """The MockProvider produces an obviously-canned quote. PM1 and PM5
    meet here: the capability gate must keep it out of the price block
    even though the mock is perfectly happy to answer."""
    from engine.public_market import prices as prices_mod
    from engine.public_market import providers as providers_mod

    mock = providers_mod.MockProvider()
    quote = mock.eod_price("AAPL")
    assert quote["mock"] is True
    assert G.source_is_model_authored(quote["provenance"]["source"])
    assert prices_mod.price_block("AAPL", "US", env={}, provider=mock) is None


def test_pm5_us_serves_fully_live_without_a_key():
    """EDGAR is keyless and official. With PROVIDER_API_KEY unset and
    every egress path trapped, a ticker still resolves to real figures
    with per-figure accessions."""
    saved = os.environ.pop("PROVIDER_API_KEY", None)
    try:
        with G._temp_store() as store, G._NoNetwork() as trap:
            store.put_filing(G.build_reference_envelope())
            body, status = G._company_via_router(store, "us", "AAPL")
            assert status == 200, body
            figures = body["envelope"]["figures"]
            assert "revenue" in figures
            assert figures["revenue"]["provenance"]["accession"]
            assert G.assert_no_model_authored_figures(body["envelope"]) == []
            assert trap.attempts == []
    finally:
        if saved is not None:
            os.environ["PROVIDER_API_KEY"] = saved


def test_pm5_every_non_live_market_degrades_to_a_typed_refusal():
    """No crash, no blank body, no 'no results for AAPL' implying a
    search happened."""
    from engine.public_market import registry as registry_mod

    with G._temp_store() as store, G._NoNetwork() as trap:
        for market in registry_mod.ordered_markets():
            if market.is_live and not market.is_home:
                continue
            body, status = G._company_via_router(store, market.market_id, "AAPL")
            assert status in (404, 501), (market.market_id, status, body)
            assert body["status"] == "refused"
            assert body["code"]
            assert body["detail"].strip()
        assert trap.attempts == []


def test_pm5_no_blank_tab():
    """Every market renders with a name, a status from the closed
    vocabulary, a currency, a licence line and an exact count."""
    from engine.public_market import registry as registry_mod

    with G._temp_store() as store:
        payload = G._registry_payload_via_router(store)
    assert payload["markets"]
    for entry in payload["markets"]:
        for field in ("display_name", "status", "currency", "license_notes",
                      "group"):
            assert str(entry.get(field) or "").strip(), (entry["market_id"], field)
        assert entry["status"] in registry_mod.STATUSES
        assert isinstance(entry["entities_held"], int)


def test_pm5_gate_verdict_is_green():
    result = G.check_pm5()
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# PM6 — registry-only extension + the N7 market-id guard
# ══════════════════════════════════════════════════════════════════════


def test_pm6_real_package_scans_clean_under_the_n7_guard():
    from engine.public_market import registry as registry_mod

    assert G.scan_market_id_literals(PACKAGE_DIR, registry_mod.market_ids()) == []


def test_pm6_plant_a_market_id_branch_in_core():
    """THE BRIEFED PLANT: a ``market_id == "us"`` ladder in core. Planted
    into a temp COPY of the real package (see the module docstring for
    why not in place), scanned with the real scanner, then dropped."""
    from engine.public_market import registry as registry_mod

    ids = registry_mod.market_ids()
    with PlantedTree(
        "model.py",
        "\ndef _planted_ladder(market_id):\n"
        "    if market_id == 'us':\n"
        "        return 'the first vertebra'\n"
        "    return None\n",
    ) as planted:
        hits = G.scan_market_id_literals(planted.root, ids)
    assert hits, "the N7 guard did not trip on a planted market-id branch"
    assert any("compares market_id" in h for h in hits), hits
    assert any("quotes market id" in h for h in hits), hits
    # REVERT proven: the real tree is clean again (it was never touched).
    assert G.scan_market_id_literals(PACKAGE_DIR, ids) == []


def test_pm6_plant_a_bare_market_id_literal():
    from engine.public_market import registry as registry_mod

    ids = registry_mod.market_ids()
    with PlantedTree("router.py", "\nDEFAULT_MARKET = 'fr'\n") as planted:
        hits = G.scan_market_id_literals(planted.root, ids)
    assert any("router.py" in h and "'fr'" in h for h in hits), hits
    assert G.scan_market_id_literals(PACKAGE_DIR, ids) == []


def test_pm6_prose_about_a_market_never_trips_the_guard():
    """Non-vacuity has a twin: a guard that fires on documentation gets
    switched off. Docstrings and bare string statements are exempt."""
    from engine.public_market import registry as registry_mod

    with PlantedTree(
        "esef.py",
        '\ndef _documented():\n'
        '    """Germany (de) is missing from the repository."""\n'
        '    return None\n',
    ) as planted:
        hits = G.scan_market_id_literals(planted.root, registry_mod.market_ids())
    assert hits == [], hits


def test_pm6_allowlist_entries_still_point_at_real_constants():
    """A stale allowlist entry silently widens the guard."""
    for (filename, constant), reason in G.MARKET_LITERAL_ALLOWLIST.items():
        assert reason and len(reason) > 20, (filename, constant)
        path = PACKAGE_DIR / filename
        assert path.is_file(), filename
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=filename)
        assert constant in set(G._module_constant_owner(tree).values()), (
            "%s no longer defines the allowlisted constant %s"
            % (filename, constant))
    for filename, reason in G.MARKET_LITERAL_EXEMPT_FILES.items():
        assert reason and len(reason) > 20, filename
        assert (PACKAGE_DIR / filename).is_file(), filename


def test_pm6_registry_only_extension_then_revert():
    """Add a fictional market to markets.yaml ALONE. It must reach the
    API with its honest state; the engine tree must be byte-identical
    before and after; and the revert must be total."""
    from engine.public_market import registry as registry_mod

    before_ids = registry_mod.market_ids()
    before_digest = G._tree_digest(PACKAGE_DIR)
    saved = os.environ.get(registry_mod.PATH_ENV)
    tmp = Path(tempfile.mkdtemp(prefix="pm6-test-registry-"))
    try:
        extended = tmp / "markets.yaml"
        extended.write_text(
            registry_mod.default_path().read_text(encoding="utf-8").rstrip("\n")
            + "\n" + G.FICTIONAL_MARKET_YAML,
            encoding="utf-8",
        )
        os.environ[registry_mod.PATH_ENV] = str(extended)
        registry_mod.reset_cache()

        market = registry_mod.get_market(G.FICTIONAL_MARKET_ID)
        assert market.is_awaiting_provider
        assert market.group == registry_mod.REST_GROUP
        assert not market.is_marquee and not market.is_home

        with G._temp_store() as store:
            payload = G._registry_payload_via_router(store)
            tab = [e for e in payload["markets"]
                   if e["market_id"] == G.FICTIONAL_MARKET_ID]
            assert tab, "a registry-only market produced no API tab"
            assert tab[0]["display_name"].strip()
            assert tab[0]["entities_held"] == 0
            body, status = G._company_via_router(
                store, G.FICTIONAL_MARKET_ID, "ANY")
            assert status == 501
            assert body["code"] == "MARKET_AWAITING_PROVIDER"
            assert body["detail"].strip()

        assert G._tree_digest(PACKAGE_DIR) == before_digest, (
            "adding a market required an engine edit")
    finally:
        if saved is None:
            os.environ.pop(registry_mod.PATH_ENV, None)
        else:
            os.environ[registry_mod.PATH_ENV] = saved
        registry_mod.reset_cache()
        shutil.rmtree(tmp, ignore_errors=True)

    assert registry_mod.market_ids() == before_ids
    assert G._tree_digest(PACKAGE_DIR) == before_digest


def test_pm6_registry_refuses_a_dishonest_new_market():
    """Registry-only extension is not registry-only LICENCE. A row that
    claims figures without naming a feed is refused at load — otherwise
    'live' becomes decoration one yaml edit at a time."""
    from engine.public_market import registry as registry_mod

    tmp = Path(tempfile.mkdtemp(prefix="pm6-dishonest-"))
    try:
        bad = tmp / "markets.yaml"
        bad.write_text(
            registry_mod.default_path().read_text(encoding="utf-8").rstrip("\n")
            + "\n" + G.FICTIONAL_MARKET_YAML.replace(
                "status: awaiting_provider", "status: live"),
            encoding="utf-8",
        )
        with pytest.raises(registry_mod.RegistryError):
            registry_mod.load_markets(bad)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_pm6_gate_verdict_is_green():
    result = G.check_pm6()
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# PM7 — BVB / public_ro untouched
# ══════════════════════════════════════════════════════════════════════


def test_pm7_no_public_ro_coupling_in_the_real_tree():
    assert G.scan_public_ro_coupling() == []


def test_pm7_plant_a_public_ro_import():
    with PlantedTree(
        "store.py",
        "from engine.public_ro.store import PublicRoStore  # PLANT\n",
    ) as planted:
        hits = G.scan_public_ro_coupling(planted.root)
    assert any("store.py" in h and "public_ro" in h for h in hits), hits
    assert_reverted()


def test_pm7_plant_reading_the_home_markets_database_path():
    """An import is one way in; the env var is the other. Opening
    public_ro's own sqlite file from this package would give one company
    two writers."""
    with PlantedTree(
        "router.py",
        "\n_PLANT = os.environ.get('PUBLIC_RO_DB_PATH')\n",
    ) as planted:
        hits = G.scan_public_ro_coupling(planted.root)
    assert any("PUBLIC_RO_DB_PATH" in h for h in hits), hits
    assert_reverted()


def test_pm7_home_market_company_route_refuses():
    from engine.public_market import registry as registry_mod

    home = registry_mod.home_market()
    with G._temp_store() as store:
        body, status = G._company_via_router(store, home.market_id, "TLV")
    assert status == 404
    assert body["code"] == "HOME_MARKET_SERVED_ELSEWHERE"
    assert home.fundamentals_source in body["detail"]


def test_pm7_home_market_still_leads_the_list():
    """Refusing the company route is not the same as hiding the market.
    Romania is its own group and comes first."""
    from engine.public_market import registry as registry_mod

    with G._temp_store() as store:
        payload = G._registry_payload_via_router(store)
    assert payload["markets"][0]["market_id"] == registry_mod.home_market().market_id
    assert payload["markets"][0]["group"] == registry_mod.HOME_GROUP


def test_pm7_marquee_order_is_the_briefed_order():
    """US, DE, UK, FR, IT, ES, CN, AE — after Romania, which is its own
    group. Ordering is a promise the FE reads; it is pinned here."""
    from engine.public_market import registry as registry_mod

    assert [m.market_id for m in registry_mod.marquee_markets()] == [
        "us", "de", "uk", "fr", "it", "es", "cn", "ae",
    ]


def test_pm7_plant_a_home_market_seed_carrying_members():
    """PLANT: the universe lane is asked to seed a Romanian issuer into
    the public_market store.

    The shipped ``seeds/ro.json`` is empty, and an empty file proves
    nothing on its own — it is a convention, and a convention is one
    commit from being wrong. This plants a member in memory and requires
    the loader to refuse it with a typed error, leaving the store empty.
    """
    from engine.public_market import registry as registry_mod
    from engine.public_market import universe as universe_mod

    home = registry_mod.home_market()
    seed = universe_mod.Seed(
        market_id=home.market_id,
        as_of="2026-08-30",
        source={"name": "PM7 plant", "url": "https://example.invalid",
                "dataset_version": "plant-1",
                "retrieved_at": "2026-08-30T00:00:00Z"},
        license_note="PM7 plant",
        coverage_note="PM7 plant — must be refused",
        members=(universe_mod.Member(name="Banca Transilvania SA",
                                     tickers=("TLV",),
                                     lei="5493008NF6ZCBUFJ0X61"),),
    )
    with G._temp_store() as store:
        with pytest.raises(universe_mod.SeedError):
            universe_mod.load_into_store(seed, store)
        assert store.entity_count(home.market_id) == 0


def test_pm7_the_shipped_home_seed_is_empty_and_says_why():
    """The convention, beside the enforcement: the file exists so the
    gap is VISIBLE and dated, not so it can be quietly filled."""
    from engine.public_market import registry as registry_mod
    from engine.public_market import universe as universe_mod

    home = registry_mod.home_market()
    seed = universe_mod.seed_for(home.market_id)
    if seed is None:  # pragma: no cover — no home seed shipped
        pytest.skip("no home-market seed file ships today")
    assert seed.is_empty
    assert seed.coverage_note.strip()


def test_pm7_peer_add_does_not_widen_a_cohort():
    """Adding a peer from another sector or another size band must not
    change the cohort it was added beside."""
    from engine.public_market.freshness.peers import (
        PeerCandidate, deterministic_peers,
    )

    subject = PeerCandidate("AAPL", "Apple Inc", "Technology", 3.0e12)
    universe = [
        PeerCandidate("MSFT", "Microsoft", "Technology", 3.0e12),
        PeerCandidate("NVDA", "NVIDIA", "Technology", 3.1e12),
    ]
    baseline = [p.ticker for p in deterministic_peers(subject, universe)["peers"]]
    widened = universe + [
        PeerCandidate("XOM", "Exxon", "Energy", 3.0e12),
        PeerCandidate("TINY", "Tiny Co", "Technology", 1.0e6),
    ]
    assert [p.ticker for p in deterministic_peers(subject, widened)["peers"]] \
        == baseline


def test_pm7_corpus_replay_is_byte_identical():
    """The BVB goldens. Runs the real replay gate and pins the case
    count: a drop is a silently deleted golden, a rise is an unreviewed
    one."""
    ok, count, tail = G.run_corpus_replay()
    assert ok, tail
    assert count == G.CORPUS_CASES, tail


def test_pm7_gate_verdict_is_green():
    result = G.check_pm7(run_replay=False)
    assert result.state == G.PASS, result.violations


# ══════════════════════════════════════════════════════════════════════
# The battery entry point itself
# ══════════════════════════════════════════════════════════════════════


def test_gate_script_exits_zero_and_reports_every_gate():
    """The operator-facing surface: seven gates reported, exit 0 while
    nothing FAILS, and PM2 reported as SKIP rather than silently green."""
    results = G.run_gates(run_replay=False)
    assert [r.gate for r in results] == [
        "PM1", "PM2", "PM3", "PM4", "PM5", "PM6", "PM7"]
    failed = [r.gate for r in results if not r.ok]
    assert not failed, [(r.gate, r.violations) for r in results if not r.ok]
    by_gate = dict((r.gate, r) for r in results)
    assert by_gate["PM2"].state == G.SKIP or G.discover_grouping_fn()[0] is not None


def test_gate_script_json_record_is_serializable():
    """The battery writes JSON records; a gate whose record cannot be
    serialized is a gate the ops surface shows as 'not recorded'."""
    results = G.run_gates(run_replay=False)
    json.dumps([r.as_dict() for r in results], sort_keys=True)


def test_gate_script_never_touches_the_deployed_database():
    """A gate that writes to the database it is auditing has changed the
    evidence — and, worse, leaves a shared artifact different for every
    test that runs after it.

    This is not hypothetical in this package: two tests in another lane
    write to the process-default store with a clock-derived content hash,
    so they pass exactly once per machine and are red on every run after
    (see design_review/markets/GATES.md, "Cross-lane needs"). Every gate
    in this lane is held to the opposite standard, and here is the proof.
    """
    import hashlib

    from engine.public_market import store as store_mod

    default = store_mod.default_db_path()
    existed = default.exists()
    before = hashlib.sha256(default.read_bytes()).hexdigest() if existed else None

    G.check_pm1()   # reads the deployed store — read-only, mode=ro
    G.check_pm3()   # seeds entities, on a temp path
    G.check_pm5()
    G.check_pm6()
    G.check_pm7(run_replay=False)

    assert default.exists() == existed, (
        "a gate created %s — it must never write the deployment's store"
        % default)
    if existed:
        after = hashlib.sha256(default.read_bytes()).hexdigest()
        assert after == before, (
            "a gate MUTATED %s (%s -> %s)" % (default, before, after))
