#!/usr/bin/env python3
"""The full engine battery, one command — and the writer of the battery
record the ops surface reads.

Runs every gate in the canonical order, prints one legible
``PASS <gate>`` / ``FAIL <gate>`` line per gate (the same text shape
``engine.obs.status`` accepts), and drops the JSON record at
``data/obs/battery_last.json`` (``ENGINE_OBS_DIR`` moves the directory,
``ENGINE_BATTERY_LOG`` points at an explicit file) so ``/ops`` and
``scripts/engine_ops.py status`` show per-gate results instead of
"not recorded". This closes the documented convention in
``src/engine/obs/status.py`` — before this wrapper existed, nothing in
the repo wrote the record.

════════════════════════════════════════════════════════════════════════
EXIT ZERO IS NOT EVIDENCE — WHY EVERY GATE CARRIES A WORK COUNT
════════════════════════════════════════════════════════════════════════

``npx tsc --noEmit`` sat in this list for months and every lane pasted
its green as proof. It checked ZERO FILES: the root ``tsconfig.json`` is
solution-style (``"files": []`` + ``references``), so without ``-b`` tsc
obeys the empty file list, finds nothing, and exits 0 in 0.2 s. It hid
102 real type errors across 32 files. The runtime was the tell, and a
green gate invites nobody to read its runtime.

Three siblings, all real, all in this repo: ``check_metric_declared.py``
first draft scanned keyword arguments only and printed a PASS over "0
metrics" for a package holding dozens; ``check_stale_gates.mjs`` first
draft matched ``data-testid=`` attributes only and called 20 live ids
stale; ``e2e/design/capsule.spec.ts`` had three gates that passed
vacuously and would have kept passing with their invariant deleted.

So a gate's exit code is only HALF its verdict here. Every gate declares:

  WORK   a machine-readable count of what it actually examined, read
         back out of the gate's own output (a regex over what it
         prints, or the junit-xml pytest writes), plus a FLOOR. Work
         below the floor is a FAIL even on exit 0. A census that finds
         nothing is a broken gate, never a passing one.
  CANARY a literal the gate MUST emit — a fixture name, a rule id, a
         test id. Absent => ``DISCOVERY BROKEN``, the antibody already
         proven in ``check_metric_declared.py`` and ``check_stale_gates.mjs``.

Two gates take their count from an EXTERNAL proxy (marked in the table
and in the record) because the script that runs them is not this lane's
file to edit; see docs/engine_book/gates.md § cross-lane.

One state is neither green nor red: ``PASS(VACUOUS)`` — the gate ran
clean and examined nothing, because the data it audits is absent on this
host. It is spelled out rather than folded into the green count, since
"it passed" and "it had nothing to look at" must never read the same.

Registry, plant log and the proven-RED transcript for every gate:
  docs/engine_book/gates.md
Mechanical enforcement (a new gate without a canary/floor/plant fails):
  tests/engine/test_gate_canaries.py

Usage:
  python scripts/run_battery.py                # full battery (host)
  python scripts/run_battery.py --engine-only  # skip the frontend gates
                                               # (tsc + npm build)
  python scripts/run_battery.py --list         # print the gate list
  python scripts/run_battery.py --show-work    # print the work/canary
                                               # contract for each gate

Exit codes: 0 = every gate green; 1 = at least one FAIL (the record is
written either way — an honest red record beats a stale green one).

NOT in the default battery (deliberately): the mutation kernel
(scripts/run_mutation_kernel.py — ~16 min full run; nightly CI owns it,
the PR profile needs a diff base) and the DST deep profile
(DST_PROFILE=deep — nightly). The per-PR DST profile IS included.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]

# EMPTY, and it should stay that way. It used to hold two deselects for "the
# pre-existing SHARADAR market-cap scaling defect in the adapter". There was
# no adapter defect: SHARADAR/DAILY documents marketcap and ev as USD
# millions, the adapter's 1e6 multiplication at both DAILY call sites is
# correct, and the committed FIXTURE held absolute USD — so the adapter
# looked a million times wrong and two honest tests were switched off for
# months instead. Fixed 2026-09-04 by correcting the fixture.
#
# The cost of the deselect was not the two tests. It was that the battery
# reported green over a money-unit question nobody re-opened, and a later
# wave "fixed" the adapter to match the wrong fixture, which would have
# shipped Apple at USD 3.78M. A deselect is a gate you have agreed not to
# look at; prefer an xfail with a reason, or fix it.
PYTEST_DESELECTS = []

PY = sys.executable


class Gate(object):
    """One battery gate and the proof that it did work.

    ``work_rx``     regex over the gate's combined stdout+stderr whose
                    group 1 is the count. With ``work_sum`` every match
                    is summed; otherwise the LAST match wins (summary
                    lines come last).
    ``work_count_rx`` count the NUMBER of matching lines instead of
                    reading a captured number — for gates that report
                    per-item and never total.
    ``work_junit``  read the count out of the junit-xml pytest writes
                    (``tests`` minus ``skipped``); canaries are matched
                    against the recorded testcase names.
    ``work_glob``   EXTERNAL proxy: count files matching these globs.
                    Only for gates whose script is not this lane's to
                    edit; every use is named in gates.md § cross-lane.
    ``floor``       minimum honest work. Below it the gate FAILS even on
                    exit 0. Set from a measured run, then rounded down —
                    it is a collapse detector, not a ratchet.
    ``canaries``    literals the output MUST contain. Missing => the
                    gate's discovery is broken, whatever its exit code.
    ``vacuous_ok``  0 work is reported as PASS(VACUOUS), not green.
    """

    def __init__(self, name, cmd, floor=0, units="items", canaries=(),
                 work_rx=None, work_sum=False, work_count_rx=None,
                 work_junit=False, work_glob=None, vacuous_ok=False,
                 external_reason=""):
        self.name = name
        self.cmd = cmd
        self.floor = floor
        self.units = units
        self.canaries = tuple(canaries)
        self.work_rx = work_rx
        self.work_sum = work_sum
        self.work_count_rx = work_count_rx
        self.work_junit = work_junit
        self.work_glob = tuple(work_glob or ())
        self.vacuous_ok = vacuous_ok
        self.external_reason = external_reason

    # BACKWARD COMPATIBILITY, DELIBERATE.
    #
    # `_gates()` used to return plain `(name, cmd)` tuples and callers
    # outside this file unpack them that way — e.g.
    # `dict(run_battery._gates(True))` in tests/engine/test_error_budget.py.
    # Turning the list into objects without keeping that shape would have
    # broken another lane's test for a reason unrelated to what it
    # asserts, so a Gate still IS a 2-sequence of (name, cmd).
    def __iter__(self):
        return iter((self.name, self.cmd))

    def __getitem__(self, i):
        return (self.name, self.cmd)[i]

    def __len__(self):
        return 2

    def __repr__(self):
        return "Gate(%r, floor=%d)" % (self.name, self.floor)

    @property
    def source(self) -> str:
        if self.work_junit:
            return "junit-xml"
        if self.work_glob:
            return "EXTERNAL(glob)"
        if self.work_count_rx:
            return "stdout(line-count)"
        if self.work_sum:
            return "stdout(sum)"
        return "stdout"


# ──────────────────────────────────────────────────────────────────────
# THE GATE TABLE
#
# Floors are measured, then rounded DOWN with slack. They exist to catch
# collapse (a suite that stops collecting, a walker that stops walking),
# not to ratchet a number upward — a floor tightened to chase a count is
# the same sin as a threshold loosened to meet one.
#
# ADDING A GATE — four things, and the fourth is the one people skip:
#
#   1. the command;
#   2. a WORK count the gate already prints (work_rx / work_count_rx),
#      or work_junit for a pytest gate. If it prints none, add one to
#      the gate — a work_glob proxy is for scripts another lane owns,
#      and needs an external_reason;
#   3. a FLOOR, measured from a real run and rounded down, plus at least
#      one CANARY specific enough that an empty run could not print it;
#   4. a section in docs/engine_book/gates.md with the plant you applied,
#      the RED output you observed, and the revert.
#
# tests/engine/test_gate_canaries.py fails if any of 2-4 is missing, so
# a gate cannot enter this list without evidence that it can fail.
# ──────────────────────────────────────────────────────────────────────

def _engine_gates() -> List[Gate]:
    return [
        Gate("pytest",
             [PY, "-m", "pytest", "tests/engine", "-q"] + PYTEST_DESELECTS,
             work_junit=True, floor=1500, units="tests",
             canaries=("test_regeneration_is_byte_identical",
                       "test_this_gate_is_itself_catalogued")),
        Gate("corpus-replay", [PY, "scripts/corpus_replay.py"],
             work_rx=r"CORPUS REPLAY: \w+ — (\d+) case", floor=18,
             units="corpus cases",
             canaries=("saga_10_col", "pdf_positional")),
        # W1-W6 — PERIOD-ASSIGNMENT INTEGRITY. `period_end` is the period's
        # identity, and the 2026-08-30 audit found it being set from UI
        # state (the drop target's date written into the human-confirmation
        # channel), filing a 2025 trial balance under 2017-12. These gates
        # pin the law: the period comes from the DOCUMENT, absence forces an
        # explicit choice, wrong rows are surfaced and never rewritten. Named
        # separately from `pytest` so the battery record shows it by name —
        # this class of defect is silent, so its gate must not be.
        # Contract + plant log: design_review/period/GATES.md
        Gate("period-integrity",
             [PY, "-m", "pytest", "tests/engine/test_period_integrity_gates.py", "-q"],
             work_junit=True, floor=10, units="tests",
             canaries=("test_w1_scanner_catches_the_exact_production_plant",
                       "test_w3_carniprod_2025_filed_under_2017_is_recorded_as_a_mismatch")),
        # F2 — FINDING SPECIFICITY. The measured baseline (BASELINE.md) had
        # 80% of live findings with no imperative verb and 58% citing fewer
        # than two figures; the generic-note failure is silent, so its gate
        # must not be. Lints every surfaced finding on the real fixtures and
        # runs the swap test. F1/F3-F9 ride the `pytest` gate above
        # (tests/engine/test_findings_gates.py); plant log:
        # design_review/findings/GATES.md
        Gate("finding-specificity", [PY, "scripts/check_finding_specificity.py"],
             work_rx=r"GATE-WORK finding-specificity units=(\d+)", floor=20,
             units="surfaced findings",
             canaries=("liquidity_cash_tight", "scandia_fy2025")),
        # C1-C9 — THE CAPSULE, engine half: no figure in the language
        # channel handed to the model, no reachable write tool, provenance
        # on every value, a named gap instead of the month next door, and
        # ratios invariant across currencies. Named separately from
        # `pytest` because a fabricated figure fails silently, so its gate
        # must not. Plant log: design_review/capsule/GATES.md
        # The six firm-* gates live in the working tree, NOT here: their test
        # files (test_firm_gates / test_firm_attention / test_firm_tenancy)
        # are part of the uncommitted Firm Cockpit backend, so a gate naming
        # them would red a clean checkout of main. Their gates.md sections are
        # already written; re-add the Gate lines in the same commit that lands
        # the Cockpit tests. Removed 2026-09-04 after they reached main early.
        Gate("capsule-gates",
             [PY, "-m", "pytest", "tests/engine/test_capsule_gates.py", "-q"],
             work_junit=True, floor=15, units="tests",
             canaries=("test_c1_no_figure_ever_reaches_the_language_channel",
                       "test_c2_a_planted_write_tool_never_executes_through_the_dispatcher",
                       "test_c5_absent_period_answers_with_the_gap_and_no_number")),
        # FC7 + FC8 — THE FIRM COCKPIT (backend). FC7: a file uploaded via
        # a request link lands through the NORMAL pipeline (same row shape,
        # same status + enqueue, the request's period as the confirmation
        # hint) and the period-mismatch and entity guards FIRE on a
        # wrong-period / wrong-entity file. FC8: model mocked DEAD ->
        # items, calendar, digest, brief all complete with an honest
        # notice and zero raw payload; a model call planted in the ranking
        # path reds the structural assertion. Named separately from
        # `pytest` because a side channel around the pipeline and a model
        # in the ranking path both fail SILENTLY. Floor 15 = the measured
        # 22 tests, rounded down. Plant log: docs/engine_book/gates.md
        Gate("route-binding",
             [PY, "-m", "pytest", "tests/engine/test_route_bindings.py", "-q"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_no_mutating_route_demands_its_body_as_a_query_param",
                       "test_no_request_model_is_nested_inside_a_function_under_future_annotations",
                       "test_the_full_openapi_schema_generates")),
        Gate("cron-auth",
             [PY, "-m", "pytest", "tests/engine/test_cron_auth.py", "-q"],
             work_junit=True, floor=8, units="tests",
             canaries=("test_cron_without_a_configured_token_is_503_never_run",
                       "test_cron_with_a_wrong_bearer_is_refused")),
        Gate("public-refresh-shield",
             [PY, "-m", "pytest", "tests/engine/test_public_refresh_shield.py", "-q"],
             work_junit=True, floor=20, units="tests",
             canaries=("test_both_guarded_routes_still_exist_on_the_real_app",
                       "test_anonymous_calls_are_limited_after_the_budget",
                       "test_a_limited_call_mutates_no_cache",
                       "test_a_valid_bearer_is_never_limited",
                       "test_rotating_a_spoofed_leftmost_hop_cannot_mint_new_buckets",
                       "test_the_shield_and_the_limiter_read_the_same_hop")),
        Gate("public-post-surface",
             [PY, "-m", "pytest", "tests/engine/test_public_post_surface.py", "-q"],
             work_junit=True, floor=21, units="tests",
             canaries=("test_every_public_post_on_the_real_app_is_classified",
                       "test_the_walled_payloads_are_valid_so_a_401_means_the_wall",
                       "test_a_walled_route_refuses_when_the_token_is_unset",
                       "test_a_walled_route_refuses_a_wrong_bearer",
                       "test_an_unauthenticated_manual_signal_creates_nothing",
                       "test_an_unauthenticated_filings_refresh_never_calls_edgar",
                       "test_sync_is_limited_after_the_budget",
                       "test_ps8_compliance_routes_are_walled_and_never_rate_limited")),
        Gate("determinism", [PY, "scripts/verify_determinism.py"],
             # Floor 4 = the full declared roster in the script's own
             # fixture table (prod_scandia_frozen, agras,
             # scandia_realestate, carniprod). A first draft guessed 5
             # from a truncated tail and the battery correctly failed the
             # gate as WORK BELOW FLOOR; the number here is measured, not
             # negotiated. Adding a fixture needs no edit — a floor is a
             # minimum; LOSING one goes red, which is the point.
             work_count_rx=r"^\[.+\] 5 runs — BYTE-IDENTICAL", floor=4,
             units="fixtures x5 runs",
             canaries=("prod_scandia_frozen", "anchor: SF extracted")),
        Gate("bs-drift", [PY, "scripts/measure_bs_drift.py"],
             work_count_rx=r"^\s+\S+\s+difference\s", floor=7,
             units="fixtures",
             canaries=("Scandia", "Sibiu", "identity_holds")),
        Gate("error-budget", [PY, "scripts/measure_error_budget.py"],
             work_rx=r"measured [\d.]+% on (\d+) fields", work_sum=True,
             floor=5000, units="labeled numeric fields",
             canaries=("lane deterministic", "lane classification")),
        Gate("import-boundary", [PY, "scripts/check_import_boundary.py"],
             work_rx=r"GATE-WORK import-boundary units=(\d+)", floor=200,
             units="source files",
             canaries=("engine=OK", "frontend=OK")),
        Gate("pack-lint", [PY, "scripts/pack_lint.py", "--root", "packs"],
             work_rx=r"(\d+) pack\(s\) loaded", floor=4, units="packs",
             canaries=("pack(s) loaded",)),
        Gate("shadow-report", [PY, "scripts/shadow_report.py", "--all"],
             work_rx=r"zero divergence across (\d+) case", floor=18,
             units="corpus cases",
             canaries=("saga_10_col", "accounts=")),
        # EXTERNAL work proxy — see gates.md § cross-lane. port_*_pack.py
        # --check prints "clean" and no count; check_against() fails loudly
        # on a missing file, so the file census is a faithful stand-in
        # until those scripts report their own.
        Gate("pack-drift-ro", [PY, "scripts/port_ro_pack.py", "--check"],
             work_glob=("packs/ro/omfp1802-v1/*.yaml",), floor=5,
             units="pack files compared",
             canaries=("frozen port snapshot",),
             external_reason="port_ro_pack.py is not lane A's file to edit"),
        Gate("pack-drift-hu", [PY, "scripts/port_hu_pack.py", "--check"],
             work_glob=("packs/hu/actc2000-v1/*.yaml",
                        "packs/intl/ifrs-captions-v1/*.yaml"), floor=10,
             units="pack files compared",
             canaries=("frozen port snapshot",),
             external_reason="port_hu_pack.py is not lane A's file to edit"),
        Gate("corpus-policy", [PY, "scripts/check_corpus_policy.py"],
             work_rx=r"checked (\d+) file\(s\)", floor=2500, units="tracked files",
             canaries=("corpus case(s)", "CORPUS POLICY")),
        Gate("scrub-unreachable", [PY, "scripts/check_scrub_tooling_unreachable.py"],
             work_rx=r"(\d+) executable file\(s\) swept", floor=800,
             units="executable files",
             # NB: the canaries must not spell the scrub-tooling path.
             # An earlier draft used it as a literal here and this gate
             # correctly failed the battery runner as an executable file
             # naming the tooling — a true positive, and a neat proof
             # that the gate is live. Match its verdict lines instead.
             canaries=("automation surface(s)", "closure round(s)",
                       "REACHABILITY")),
        Gate("supply-chain-selftest", [PY, "scripts/check_supply_chain.py", "--self-test"],
             work_count_rx=r"\[ok\]", floor=12, units="planted cases",
             canaries=("C5 catches a planted Anthropic key",
                       "C5 does NOT flag the public anon JWT")),
        Gate("supply-chain", [PY, "scripts/check_supply_chain.py"],
             work_rx=r"checked (\d+) tracked file\(s\)", floor=2500,
             units="tracked files",
             canaries=("lock pins=", "anthropic==")),
        Gate("engine-book", [PY, "scripts/generate_engine_book.py", "--check"],
             work_rx=r"clean \((\d+) generated pages", floor=6, units="book pages",
             canaries=("byte-identical",)),
        Gate("dst-explore", [PY, "scripts/dst_explore.py"],
             work_rx=r"dst_explore: (\d+)/\d+ passed", floor=14,
             units="fault scenarios",
             canaries=("kill_between_stages",)),
        # PS6 — every sitemapped public company URL must serve 200 with
        # real content; thin/unpublishable/taken-down CUIs must be absent.
        # VACUOUS on a host that has ingested no public data: it examines
        # nothing and says so, instead of reporting a green it has not
        # earned. The gate's LOGIC is exercised by tests/engine/
        # test_public_seo.py against a planted fixture app, in `pytest`.
        Gate("public-sitemaps", [PY, "scripts/check_public_sitemaps.py"],
             work_rx=r"GATE-WORK public-sitemaps units=(\d+)", floor=1,
             units="sitemap URLs probed", vacuous_ok=True,
             canaries=("PS6 GATE",)),
        # End-to-end against the REAL PublicRoStore. The unit suites drive a
        # FakeStore that "mirrors" it; the mirror drifted and hid two total
        # outages (every hub page 500, every funnel event dropped) behind
        # 244 green tests. This gate fakes nothing.
        Gate("public-e2e", [PY, "scripts/check_public_e2e.py"],
             work_rx=r"GATE-WORK public-e2e units=(\d+)", floor=10,
             units="live assertions",
             canaries=("PS-E2E GATE",)),
        # PM1-PM7 — GLOBAL PUBLIC MARKETS. Real registry, real sqlite store, real
        # router, real SEC bytes; --no-replay because PM7's corpus check is the
        # `corpus-replay` gate above and must not run twice per battery.
        Gate("public-market-gates",
             [PY, "scripts/check_public_market_gates.py", "--no-replay"],
             work_count_rx=r"^(?:PASS|SKIP|FAIL) PM\d", floor=7, units="PM gates",
             # The full headline, not the bare id: "PM1" alone is short
             # enough to appear in an unrelated line, and a canary that
             # can be satisfied by accident is not a canary.
             canaries=("PM1  no AI-authored numerics in the facts path",
                       "PM7  BVB / public_ro untouched")),
    ]


def _frontend_gates() -> List[Gate]:
    return [
        # Global-positioning gates (2026-08-29): Hungary never in a headline
        # (G2), certification verbs never beside global claims (G3). G1 is
        # the existing pack-drift hash freeze; G4/G5 live in vitest.
        # Unit-declaration gate — makes the 2026-08-30 "1553.0%" double-scale
        # collision unwritable at the producer (see check_metric_units.py).
        Gate("metric-units", [PY, "scripts/check_metric_units.py"],
             work_rx=r"GATE-WORK metric-units units=(\d+)", floor=50,
             units="literal metric rows",
             canaries=("METRIC UNIT GATE",)),
        # Companion to metric-units: that gate checks a PRODUCER declares a
        # unit on the row it writes; this one checks every metric a SURFACE
        # can request is known to the registry, so a legitimate figure can
        # never resolve to UNIT_UNKNOWN and be refused at render.
        Gate("metric-declared", [PY, "scripts/check_metric_declared.py"],
             work_rx=r"(\d+) distinct metric names", floor=30,
             units="distinct metric names",
             canaries=("total_assets", "capsule", "findings")),
        # NO PLANTED DEFECT MAY BE COMMITTED. Gates here are certified by
        # planting the defect they catch, observing RED, and reverting —
        # and on 2026-08-30 a `git add -A` ran while a lane's plant was
        # live, so commit 36d34ef shipped `if (false && answerLocally(…))`
        # to main: every Tier-0 question straight to the paid seam, inside
        # the commit claiming that gate works. It missed production only
        # because the last deploy predated it. A plant reads as ordinary
        # code and the suite stays green, because the one gate that would
        # catch it is the one nobody re-runs before committing.
        # THE CAPSULE READS AS A CONVERSATION. Static half of the craft
        # laws — no native tooltips, no category column, one voice per
        # line, live spec anchors. It existed for a full wave WITHOUT A
        # RUNNER: not in this table, not in any workflow, not in
        # package.json. Every reference to it in the repo was prose. A
        # gate nobody runs and a gate that passes wrongly fail the same
        # way, so it is wired here rather than described.
        # THE TEST SUITE MUST NOT DEPEND ON AN UNTRACKED LOCAL FILE.
        # `npx vitest run` was green only because a developer's real
        # Supabase URL sat in a gitignored `.env`; with it emptied, three
        # MONEY-BOUNDARY tests went red, and they had been reaching a
        # live Supabase project. On a bare clone the suite issued 33 GETs
        # at production. Differential: every recorded variable must
        # resolve identically with the local dotenv files loaded and with
        # none. ~50s, which is why it sits near the end.
        # NO TEST PATH MAY BE ABLE TO WRITE TO PRODUCTION. The sibling of
        # `hermetic`, and the hole `hermetic` did not cover: that gate made
        # VITEST hermetic, while Playwright drives the DEV SERVER, which
        # reads dotenv directly and never consults the manifest. `.env`
        # held the production Supabase URL and `.env.local` held
        # VITE_PUBLIC_TEST_MODE=1; vite merges them, so the dev server ran
        # in test mode against production and every cold boot created a
        # real organisation. 8,880 junk rows, 99.6% of that table.
        Gate("test-env-isolation",
             ["node", "scripts/check_test_env_isolation.mjs"],
             work_rx=r"units=(\d+)", floor=1,
             units="env vars examined",
             canaries=("TEST-ENV ISOLATION", "sanctioned supabase")),
        Gate("hermetic", ["node", "scripts/check_hermetic.mjs"],
             work_rx=r"GATE-WORK hermetic units=(\d+)", floor=14,
             units="recorded environment variables",
             canaries=("HERMETICITY", "comparisons")),
        Gate("capsule-craft", ["node", "scripts/check_capsule_craft.mjs"],
             work_rx=r"GATE-WORK capsule-craft units=(\d+)", floor=100,
             units="capsule files + rows + bundles + spec anchors",
             canaries=("familiesGated", "rowComponents")),
        Gate("no-plants", ["node", "scripts/check_no_plants.mjs"],
             work_rx=r"units=(\d+)", floor=400,
             units="product source files",
             canaries=("PLANT SCAN", "GATE-WORK no-plants")),
        # A gate aimed at an element that no longer exists passes for the
        # wrong reason. This is a STATIC census, so it runs in the battery
        # even though the Playwright suite it audits needs a live server —
        # which is the point: that suite is not in the battery, so nothing
        # else would have noticed the drift.
        Gate("stale-gates", ["node", "scripts/check_stale_gates.mjs"],
             work_rx=r"(\d+) app files define", floor=300,
             units="app files scanned",
             canaries=("gate files reference", "app files define")),
        # K1/K8 — THE CAPSULE IS ASK-FIRST. Static half: the command-surface
        # placeholder leads with an ask verb (EN + RO), "Ask" is not a list
        # row, and the header budget agrees with the header lane's own set.
        # In the battery because production shipped "Search pages, actions,
        # periods, companies…" for months while every C-gate stayed green —
        # a surface can satisfy every correctness law and still tell the
        # reader to do the wrong thing. Live half (K1-K9, needs vite :5173 +
        # engine :8000): e2e/design/capsule.spec.ts. Plants: design_review/capsule/GATES.md
        Gate("capsule-ask", ["node", "scripts/check_capsule_ask.mjs"],
             work_rx=r"GATE-WORK capsule-ask units=(\d+)", floor=100,
             units="source+spec files scanned",
             canaries=("header-command-bar", "SANCTIONED_DESKTOP")),
        # U1/U3 — NARRATIVE UNITS. A note that reads "holds RON 7,692,203 — 19.6%
        # of total assets 7.467.122,25 €" is one claim in two currencies; the
        # ratio was correct and the sentence still made it unverifiable. This
        # lints the narrative PRODUCERS (a template must not bake in a currency
        # or build its own money numeral); U1's render-level twin is
        # tests/engine/test_narrative_units.py (in `pytest`) and
        # frontend/lib/__tests__/narrativeUnitGates.test.tsx (in vitest).
        # Known violations are quarantined by name — a ratchet, not an
        # exemption. Contract + plant log: design_review/narrative/GATES.md
        Gate("narrative-units", ["node", "scripts/check_narrative_units.mjs"],
             work_rx=r"(\d+) narrative producer\(s\) scanned", floor=7,
             units="narrative producers",
             canaries=("NARRATIVE-UNITS",)),
        # PROVENANCE ON HOVER — the census and the contrast, in that order.
        #
        # The census is the two-sided registry: it discovers every figure
        # render site, fails on any that carries no payload verdict, and
        # fails on the FABRICATION SHAPE that shipped — a `source:` fed
        # from a period label, which put "Source  FY 2025" over a figure
        # whose real sheet and account codes were being discarded. In the
        # battery because that defect was found by READING, and reading
        # is not a control.
        Gate("provenance-census", ["node", "scripts/check_provenance_census.mjs"],
             work_rx=r"GATE-WORK provenance-sites units=(\d+)", floor=80,
             units="figure render sites",
             canaries=("PROVENANCE CENSUS", "GATE-WORK provenance-census")),
        # The affordance's own contrast, computed from the token sheet in
        # BOTH themes. Its subject is exactly the class that shipped: the
        # card's labels used `--ink-mute`, which measures 3.53:1 on the
        # popover in light — an AA failure that reads perfectly fine, and
        # the dotted underline that announces provenance measured 1.78:1
        # against a 3:1 non-text floor. Neither is visible to a screenshot
        # diff or to a human eye; both are arithmetic.
        Gate("provenance-contrast", ["node", "scripts/check_provenance_contrast.mjs"],
             work_rx=r"GATE-WORK provenance-contrast units=(\d+)", floor=6,
             units="colour nodes measured in both themes",
             # Both canaries are lines only a REAL run can print: the
             # first names the file the subjects are parsed out of (so a
             # gate that lost its component is loud), the second is the
             # underline row's own threshold label (so a gate that lost
             # the non-text check is loud). The floor of 6 is 2 themes x
             # (2 text classes + 1 underline) — it went from 20 to 6 when
             # the gate stopped measuring a hand-written list and started
             # measuring the component, which is fewer nodes and a real
             # subject instead of more nodes and a copy.
             canaries=("subjects parsed from", "non-text 3:1")),
        Gate("global-positioning", ["node", "scripts/check_global_positioning.mjs"],
             work_rx=r"GATE-WORK global-positioning units=(\d+)", floor=400,
             units="frontend files scanned",
             canaries=("GLOBAL-POSITIONING GATES",)),
        # `npx tsc --noEmit` sat here and CHECKED ZERO FILES. The root
        # tsconfig.json is solution-style — `"files": []` plus references —
        # so without `-b` tsc obeys the empty file list and exits 0 in 0.2s.
        # Every lane pasted it as proof for months while 102 real type errors
        # accumulated across 32 files. The 0.2s runtime was the tell; a green
        # gate invites nobody to read its runtime. The work count below is
        # the direct antibody: the false green reported ZERO project files.
        Gate("tsc", ["node", "scripts/check_tsc.mjs"],
             work_rx=r"GATE-WORK tsc units=(\d+)", floor=400,
             units="project files typechecked",
             canaries=("tsconfig.app.json",)),
        Gate("npm-build", ["npm", "run", "build"],
             work_rx=r"(\d+) modules transformed", floor=1000,
             units="modules transformed",
             canaries=("dist/index.html",)),
    ]


def _gates(engine_only: bool) -> List[Gate]:
    gates = _engine_gates()
    if not engine_only:
        gates += _frontend_gates()
    return gates


# Kept for callers that only want the (name, cmd) shape — engine_ops and
# the docs test read this rather than re-deriving the command list.
def gate_specs(engine_only: bool = False) -> List[Gate]:
    return _gates(engine_only)


# ──────────────────────────────────────────────────────────────────────
# Work extraction
# ──────────────────────────────────────────────────────────────────────

def _junit_facts(path: Path) -> Tuple[Optional[int], List[str]]:
    """(tests actually run, testcase names) from a pytest junit-xml."""
    try:
        root = ET.parse(str(path)).getroot()
    except (OSError, ET.ParseError):
        return None, []
    suites = [root] if root.tag == "testsuite" else list(root)
    total = 0
    names: List[str] = []
    for suite in suites:
        if suite.tag != "testsuite":
            continue
        try:
            total += int(suite.get("tests", "0")) - int(suite.get("skipped", "0"))
        except ValueError:
            pass
        for case in suite.iter("testcase"):
            name = case.get("name")
            if name:
                names.append(name)
    return total, names


def _extract_work(gate: Gate, out: str, junit: Optional[Path]) -> Tuple[Optional[int], List[str]]:
    """Returns (units, canary-haystack-lines). units is None when the gate
    reported no count at all — which is itself a failure, not a zero."""
    if gate.work_junit:
        if junit is None:
            return None, []
        units, names = _junit_facts(junit)
        return units, names
    if gate.work_glob:
        n = 0
        for pattern in gate.work_glob:
            n += len(glob.glob(str(REPO / pattern)))
        return n, out.splitlines()
    if gate.work_count_rx:
        rx = re.compile(gate.work_count_rx, re.M)
        return len(rx.findall(out)), out.splitlines()
    if gate.work_rx:
        found = re.findall(gate.work_rx, out)
        if not found:
            return None, out.splitlines()
        if gate.work_sum:
            return sum(int(x) for x in found), out.splitlines()
        return int(found[-1]), out.splitlines()
    return None, out.splitlines()


def _missing_canaries(gate: Gate, haystack: List[str]) -> List[str]:
    blob = "\n".join(haystack)
    return [c for c in gate.canaries if c not in blob]


# ──────────────────────────────────────────────────────────────────────
# Record
# ──────────────────────────────────────────────────────────────────────

def _record_path() -> Path:
    env = os.environ.get("ENGINE_BATTERY_LOG")
    if env:
        return Path(env)
    obs = os.environ.get("ENGINE_OBS_DIR")
    base = Path(obs) if obs else REPO / "data" / "obs"
    return base / "battery_last.json"


def _write_record(gates: Dict[str, Dict[str, object]], notices: List[str]) -> Optional[Path]:
    target = _record_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "gates": gates,
            "notices": notices,
        }
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, target)
        return target
    except OSError as exc:  # record failure must not mask gate results
        print("NOTICE battery record not written (%s)" % exc)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine-only", action="store_true",
                    help="skip the frontend gates (tsc, npm build)")
    ap.add_argument("--list", action="store_true", help="print the gate list")
    ap.add_argument("--show-work", action="store_true",
                    help="print each gate's work-count source, floor and canaries")
    args = ap.parse_args(argv)

    gates = _gates(args.engine_only)
    if args.list:
        for g in gates:
            print("%-22s %s" % (g.name, " ".join(g.cmd)))
        return 0
    if args.show_work:
        print("%-22s %-18s %8s  %-28s %s"
              % ("gate", "work source", "floor", "units", "canaries"))
        for g in gates:
            print("%-22s %-18s %8d  %-28s %s"
                  % (g.name, g.source, g.floor, g.units, ", ".join(g.canaries) or "—"))
        return 0

    results: Dict[str, Dict[str, object]] = {}
    notices: List[str] = []
    failed: List[str] = []
    vacuous: List[str] = []
    tmpdir = tempfile.mkdtemp(prefix="battery-junit-")

    for g in gates:
        junit: Optional[Path] = None
        cmd = list(g.cmd)
        if g.work_junit:
            junit = Path(tmpdir) / ("%s.xml" % g.name)
            cmd += ["--junit-xml=%s" % junit]
        t0 = time.monotonic()
        out = ""
        try:
            proc = subprocess.run(
                cmd, cwd=REPO, capture_output=True, text=True, timeout=3600
            )
            code: Optional[int] = proc.returncode
            out = proc.stdout + proc.stderr
            tail = out.strip().splitlines()[-12:]
        except FileNotFoundError as exc:
            code, tail = None, ["command not found: %s" % exc]
        except subprocess.TimeoutExpired:
            code, tail = None, ["gate timed out after 3600s"]
        elapsed = round(time.monotonic() - t0, 1)

        units, haystack = _extract_work(g, out, junit)
        missing = _missing_canaries(g, haystack) if code == 0 else []

        ok = code == 0
        state = "PASS"
        reasons: List[str] = []
        if not ok:
            state = "FAIL"
            reasons.append("exit %s" % code)
        else:
            if units is None:
                state = "FAIL"
                reasons.append(
                    "WORK-COUNT MISSING — the gate printed no count this "
                    "battery can read (%s / %r). A gate that cannot say what "
                    "it examined is the tsc failure wearing a green hat."
                    % (g.source, g.work_rx or g.work_count_rx or "junit"))
            elif units == 0 and g.vacuous_ok:
                state = "VACUOUS"
                reasons.append("examined 0 %s on this host" % g.units)
            elif units < g.floor:
                state = "FAIL"
                reasons.append(
                    "WORK BELOW FLOOR — examined %d %s, floor %d. A census "
                    "that finds (almost) nothing is a broken gate, not a "
                    "passing one." % (units, g.units, g.floor))
            if missing:
                state = "FAIL"
                reasons.append(
                    "DISCOVERY BROKEN — canary absent from the gate's own "
                    "output: %s" % ", ".join(repr(m) for m in missing))

        results[g.name] = {
            "ok": state != "FAIL",
            "exit_code": code,
            "seconds": elapsed,
            "work_units": units,
            "work_floor": g.floor,
            "work_label": g.units,
            "work_source": g.source,
            "canaries": list(g.canaries),
            "canaries_missing": missing,
            "state": state,
        }
        if g.external_reason:
            results[g.name]["work_external_reason"] = g.external_reason

        if state == "PASS":
            print("PASS %s (%.1fs, %s %s)" % (g.name, elapsed, units, g.units),
                  flush=True)
        elif state == "VACUOUS":
            vacuous.append(g.name)
            print("PASS %s (%.1fs) — VACUOUS: %s" % (g.name, elapsed, reasons[0]),
                  flush=True)
        else:
            failed.append(g.name)
            print("FAIL %s (exit %s, %.1fs)" % (g.name, code, elapsed), flush=True)
            for r in reasons:
                print("     ! %s" % r, flush=True)
            for line in tail:
                print("     | %s" % line, flush=True)

    if args.engine_only:
        notices.append("NOTICE frontend gates (tsc, npm-build) skipped: --engine-only")
    for name in vacuous:
        notices.append(
            "NOTICE %s ran clean and examined NOTHING (vacuous) — its subject "
            "is absent on this host; it is not counted as evidence." % name)

    written = _write_record(results, notices)
    for n in notices:
        print(n)
    print(
        "BATTERY: %s — %d/%d gates green%s%s"
        % (
            "FAIL" if failed else "PASS",
            len(gates) - len(failed) - len(vacuous),
            len(gates),
            ", %d VACUOUS (%s)" % (len(vacuous), ", ".join(vacuous)) if vacuous else "",
            "  (record: %s)" % written if written else "",
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
