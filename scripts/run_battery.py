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
        # TENANT BOUNDARY — the anatomy that produced two P0s on
        # 2026-09-09, an hour apart: a BROWSER-WRITTEN column consumed by
        # raw value inside a SERVICE-ROLE operation, behind a wall that
        # checks a different object. storage_path minted signed URLs for
        # another org's raw trial balance; period_id hard-deleted another
        # org's whole analysis; uploaded_by charged their quota and metered
        # their Stripe subscription. Under the service role RLS does not
        # apply, so the FILTER is the access control — a guard sitting in
        # an earlier early-return is one edit away from being bypassed.
        # These four suites are the permanent form of that sweep: the
        # storage seam, the period seam, a static census that fails any
        # NEW unfiltered service-role call on a tenant table, and cross-org
        # reads against the real app. Plant log:
        # docs/engine_book/gates.md
        Gate("tenant-boundary",
             [PY, "-m", "pytest",
              "tests/engine/test_storage_tenant_paths.py",
              "tests/engine/test_period_id_tenant_boundary.py",
              "tests/engine/test_service_role_tenant_filter.py",
              "tests/engine/test_cross_org_reads.py", "-q"],
             # + the period-move sibling and sales-rerun laws (tenancy
             # hotfix 2026-10-02): measured 47, floor 41.
             work_junit=True, floor=41, units="tests",
             canaries=("test_another_orgs_path_is_refused_for_every_operation",
                       "test_make_active_refuses_a_period_in_another_workspace",
                       "test_every_unfiltered_service_role_call_is_declared",
                       "test_a_member_of_another_workspace_cannot_read_org_a1",
                       "test_another_workspaces_document_is_never_a_sibling_of_my_period",
                       "test_a_dataset_pointing_at_another_workspaces_document_signs_nothing")),
        Gate("route-binding",
             [PY, "-m", "pytest", "tests/engine/test_route_bindings.py", "-q"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_no_mutating_route_demands_its_body_as_a_query_param",
                       "test_no_request_model_is_nested_inside_a_function_under_future_annotations",
                       "test_the_full_openapi_schema_generates")),
        # UPLOAD-REAL-TYPE (hotfix/upload-real-type 31dfce26 + b58bdff8,
        # landed in release r-rulings2, 2026-10-01): the 2026-09-23 incident —
        # a Word document named balanta_de_verificare_07.2025.pdf travelled
        # the whole PDF branch and came back as "Claude extraction failed:
        # your credit balance is too low". Through the REAL stage_extract with
        # only the signed URL and the download stubbed, and the Claude lane's
        # entry point and the Anthropic constructor as tripwires: a Word /
        # PowerPoint / OpenDocument file reaches NO reader on any branch and
        # is refused by name (a mismatch sentence, or the unsupported-format
        # one for an honestly named .docx); an Excel balance named .pdf and a
        # balance PDF named .xls are READ, as their bytes are (the readers
        # dispatch on magic bytes); text and unnameable bytes keep today's
        # behaviour; the guard refetches when the first download failed; the
        # failure handler stores the sentence without a class name. Measured
        # 27 tests. The 2026-10-01 review round: a legacy Word .doc / .ppt is
        # told apart from an .xls by its OLE2 directory and refused under
        # every name; each branch refuses what none of ITS readers opens
        # (`_upload_type.refused_on` — text / empty / an archive on the .pdf
        # branch, a workbook / PDF / OLE2 / archive on the text branches);
        # a non-PDF the positional reader declined never reaches the Claude
        # PDF lane; the ODF `mimetype` read is bounded on what is read; the
        # sentence is in the uploader's language. Measured 88 tests.
        # ONE UPLOAD POLICY, READ BY REAL TYPE (coordinator ruling
        # 2026-10-02, review round 3): PDF bytes are read by the .pdf
        # branch's own readers under EVERY name — the strict text-line
        # reader first, its refusal final — so a five-pair balanta named
        # .xls is no longer served with one account or its net profit
        # sign-flipped (the HIGH finding: three books under ten names,
        # byte-identical to the .pdf-named read or the identical refusal);
        # a workbook named .pdf reads as the same bytes named .xlsx; the
        # spreadsheet branch refuses by name the text / unnameable / archive
        # bytes none of its readers opens; the upload card's routes
        # (/api/uploads/identify, /commit) take the pipeline guard's own
        # verdict and sentence (`_upload_type.upload_refusal`) over a
        # 198-pair matrix, EN and RO, and at the HTTP seam
        # (test_workspace_uploads.py, now in this gate); the picker offers
        # no type the engine refuses by name. Measured 173 tests.
        # REVIEW ROUND 4 (2026-10-02): read by real type in BOTH directions
        # and at every layer. A workbook named .pdf leaves the .pdf branch
        # for the spreadsheet branch (`reads_as_workbook`), so a small
        # balance and a statutory F30/F10 return read as under .xlsx instead
        # of being refused late, after the card said "read" (the equality
        # law now runs four books and the MIME-only claim); the positional
        # reader's acceptance gate is held from below under every name (a
        # dialect book without its 121 row); the routes' matrix carries rows
        # where the declared MIME type alone picks the branch; and the
        # company IDENTIFIER reads its bytes, not its name (HIGH: a workbook
        # named .pdf was "unreadable", filed in the company on screen, and
        # walked through the cross-company wall — see workspace-v2).
        # Measured 177 tests.
        # REVIEW ROUND 5 (2026-10-02): the identifier's dispatch IS the
        # pipeline's label (`sniff_container`), and it is handed the declared
        # MIME type — two crafted byte shapes ("PK" + bytes + a PDF; a PDF
        # with bytes at both ends whose branch the MIME type picks) were PDFs
        # to the pipeline and "unreadable" to the identifier, and walked
        # through the takeover wall. One law over three bodies x nineteen
        # (name, MIME) pairs, through the routes' seam too. Measured 178.
        # Plant log: gates.md "upload-real-type".
        Gate("upload-real-type",
             [PY, "-m", "pytest", "tests/engine/test_upload_real_type.py",
              "tests/engine/test_workspace_uploads.py", "-q"],
             work_junit=True, floor=178, units="tests",
             canaries=("test_a_docx_named_pdf_is_refused_before_the_paid_path",
                       "test_an_excel_balance_named_pdf_is_READ_not_refused",
                       "test_a_balance_pdf_named_xls_is_READ_not_refused",
                       "test_pdf_bytes_are_read_by_the_pdf_readers_under_every_name",
                       "test_the_five_pair_books_of_the_high_finding_under_a_spreadsheet_name",
                       "test_a_workbook_named_pdf_reads_as_the_same_bytes_named_xlsx",
                       "test_the_spreadsheet_branch_refuses_by_name_what_none_of_its_readers_opens",
                       "test_one_upload_policy_the_routes_verdict_is_the_pipeline_guards",
                       "test_the_owners_three_files_at_the_routes_and_in_the_pipeline",
                       "test_the_upload_picker_offers_no_type_the_engine_refuses_by_name",
                       "test_the_two_files_the_pipeline_reads_are_read_by_the_card",
                       "test_the_refusal_is_in_the_language_the_card_is_read_in",
                       "test_a_docx_named_xlsx_is_refused_before_the_paid_path",
                       "test_an_honestly_named_docx_is_refused_through_the_real_branch",
                       "test_the_guard_still_runs_when_the_first_download_fails",
                       "test_the_failure_handler_stores_the_sentence_without_a_class_name",
                       "test_a_legacy_word_doc_is_refused_under_every_name_before_any_reader",
                       "test_the_pdf_branch_refuses_what_none_of_its_readers_opens",
                       "test_a_workbook_named_pdf_never_reaches_the_claude_pdf_lane",
                       "test_the_positional_readers_acceptance_gate_holds_under_every_name",
                       "test_the_identity_of_an_upload_is_read_from_its_bytes_under_every_name",
                       "test_the_identifier_reads_every_upload_on_the_branch_the_pipeline_reads_it_on",
                       "test_a_mimetype_entry_that_lies_about_its_size_is_not_inflated",
                       "test_the_real_branch_answers_in_the_language_the_run_carries")),
        # A MEMBER IS NEVER SERVED ANOTHER MEMBER'S VALUATION OVERRIDES
        # (tenancy hotfix 2026-10-02). `user_valuation_assumptions` is a
        # per-USER table; valuation/recompute and briefing/regenerate read
        # it under the service role by period only and took the first row.
        # Two members of one workspace through the REAL routes, over a
        # per-user client that applies NO row-level security (the code's
        # own filter is the wall under test); the caller's own row still
        # applies; the workspace-wide briefing is narrated on the engine's
        # valuation; no read of the table is under the service role or
        # without the user in the filter; the ONE shared valuations row is
        # persisted on the engine's figures (a save writes none of the
        # saver's); the regenerate route's period-keyed reads name the
        # tenant and the narrator's document is the period's own. Measured
        # 13. Plant log: docs/engine_book/gates.md
        # "valuation-overrides-tenancy".
        Gate("valuation-overrides-tenancy",
             [PY, "-m", "pytest", "tests/engine/test_valuation_overrides_tenancy.py", "-q"],
             work_junit=True, floor=13, units="tests",
             canaries=("test_recompute_never_serves_another_members_overrides",
                       "test_each_member_is_served_their_own_overrides",
                       "test_the_briefing_is_narrated_on_the_engines_valuation_whoever_regenerates",
                       "test_the_override_table_is_never_read_under_the_service_role_or_without_the_user",
                       "test_a_save_persists_the_engines_figures_in_the_shared_row",
                       "test_the_narrator_is_told_the_periods_own_document_and_no_foreign_row")),
        # THE WORKSPACE'S PLAN GATES A RE-RUN, AND THE STORED REFUSAL NAMES
        # NOBODY'S (owner ruling 2026-10-02). A run that holds no document
        # slot read the subscription of whoever `documents.uploaded_by`
        # named — a column the browser writes: a non-member's Multi plan
        # entitled the run, a colleague's Solo plan refused the Multi
        # owner's workspace, a NULL passed with no check; and
        # `documents.error` (read by every member) carried `plan_key` and a
        # plan-named sentence from both branches. Driven through the REAL
        # `_run_pipeline_sync` -> stage_extract -> the gate -> the failure
        # handler -> `_admin_set_status`, over a PostgREST double that
        # records every read: the owner's plan decides and the id on the
        # row is asked nothing; no owner / no org / an unreadable owner are
        # refused; the owner is resolved by role, never by sort order; the
        # stored string is the code alone; the unreachable meter stores its
        # code, not a ValueError; the first metered run stays gated by its
        # reserver; a non-member's /retry is 403. Measured 35. Plant log:
        # docs/engine_book/gates.md "entitlement-workspace-plan".
        Gate("entitlement-workspace-plan",
             [PY, "-m", "pytest", "tests/engine/test_entitlement_workspace_plan.py", "-q"],
             work_junit=True, floor=35, units="tests",
             canaries=("test_the_workspace_owners_plan_decides_whoever_uploaded_by_names",
                       "test_a_null_uploader_is_gated_by_the_workspace_not_waved_through",
                       "test_a_workspace_with_no_owner_row_is_refused",
                       "test_a_document_with_no_workspace_is_refused",
                       "test_the_owner_is_resolved_by_role_never_by_sort_order",
                       "test_a_refused_rerun_stores_the_code_and_no_plan",
                       "test_a_refused_first_run_stores_the_code_and_no_plan",
                       "test_an_unreachable_meter_stores_its_code_not_a_value_error",
                       "test_the_gate_never_reads_uploaded_by",
                       "test_a_rerun_is_refused_to_a_caller_who_is_not_a_member")),
        # A BRIEFING A MODEL FAILURE CANNOT DESTROY (owner rulings 2026-10-02
        # and 2026-10-03). `briefings` holds ONE row per period and no
        # history. Measured before the hotfix: a failed regenerate answered
        # 200 ok:true and the stored briefing BECAME "[NARRATIVE_UNAVAILABLE]"
        # (or the operator sentence); a failed re-run narration did the same
        # and deleted the period's recommendations; the same-month takeover
        # and the Docs-panel re-run lost the last good briefing the same
        # way; the route was unmetered and every deployed bundle fired it
        # from an effect. This gate was SPECIFIED with the hotfix and never
        # written: the repair shipped ungated, and when the gate was written
        # (2026-10-03) it was RED against the hotfix's own code in a dozen
        # places — the takeover with no staged briefing row, the Docs-panel
        # re-run, recommendations deleted on a failed narration, a meter
        # outage answered as a spent allowance, prose read as a provider
        # error, a reply fragment served as the briefing, the period read
        # without its tenant. Three files, one per seam, over the REAL
        # router, the real stage_narrate (only the provider client is
        # doubled), the real _usage_gate (its wire instrumented), the real
        # orchestrator for a re-run / a same-month re-upload / a sales
        # document, and the real GET /api/period: the regenerate route
        # (legacy shape inert; walls -> inputs -> meter -> model; nothing
        # written on a failure; `stale` in every answer is what is stored),
        # the other writers (stage_persist_narrative, the takeover, the
        # re-run's carry across its reset, the SKU writer), and the served
        # shape with its predicates and static censuses. Measured 640.
        # Plant log (four lists, each plant alone, byte-exact restore):
        # docs/engine_book/gates.md "briefing-keep-last-good".
        Gate("briefing-keep-last-good",
             [PY, "-m", "pytest",
              "tests/engine/test_briefing_keep_last_good_route.py",
              "tests/engine/test_briefing_keep_last_good_served.py",
              "tests/engine/test_briefing_keep_last_good_writers.py", "-q"],
             work_junit=True, floor=640, units="tests",
             canaries=("test_a_failed_regenerate_leaves_the_stored_briefing_byte_identical",
                       "test_the_bodiless_shape_answers_the_stored_briefing_and_calls_nothing",
                       "test_an_unreachable_meter_is_answered_503_metering_unavailable_never_as_a_spent_allowance",
                       "test_a_language_the_narrator_has_no_instruction_for_is_422_before_the_meter",
                       "test_stale_in_every_answer_is_what_the_stored_row_holds",
                       "test_the_body_the_frontend_card_sends_is_accepted_by_the_real_route_on_the_real_app",
                       "test_prose_is_never_mistaken_for_a_failure_text",
                       "test_the_tenant_of_the_briefing_read_is_the_periods_own_never_the_requests",
                       "test_census_no_briefings_upsert_payload_names_a_stale_column",
                       "test_a_failed_narration_never_deletes_the_periods_recommendations_whatever_the_briefing_row_holds",
                       "test_a_takeover_whose_staged_run_left_no_briefing_row_keeps_the_months_briefing",
                       "test_a_docs_panel_rerun_whose_narration_fails_still_serves_the_last_good_briefing",
                       "test_a_docs_panel_rerun_whose_narrative_write_is_refused_still_serves_what_the_reset_took",
                       "test_a_docs_panel_rerun_that_fails_after_the_narrative_stage_keeps_the_carry_for_the_next_run",
                       "test_a_failed_narration_never_replaces_a_usable_sku_briefing",
                       "test_the_runs_alerts_are_written_even_when_a_narrative_write_raises")),
        # THE PUBLIC DEMO STORE (owner ticket 2026-10-02). engine.db — the
        # SQLite file create_app() opens through PostgresAdapter — has six
        # tables and no tenant column on any of them. Anonymous POST
        # /api/cfo/today wrote the BODY's recommendations into it (the
        # default), GET /api/cfo/decisions handed every row to anyone, and
        # POST /decisions/{id}/status let anyone rewrite one. The law, on
        # the REAL create_app() over a real SQLite file: a customer-shaped
        # row planted in EVERY table is returned by no route to a caller
        # without the operator bearer (every route of the app's own table,
        # token set and token unset); no such request changes any table but
        # session_log; what one visitor posts never reaches another; the
        # operator still reads, persists and updates; a seventh table reds
        # until it is planted; the operator's count tool
        # (scripts/check_public_store.py) prints no stored value. Measured
        # 9. Plant log: docs/engine_book/gates.md "public-demo-store".
        Gate("public-demo-store",
             [PY, "-m", "pytest", "tests/engine/test_public_demo_store.py", "-q"],
             work_junit=True, floor=9, units="tests",
             canaries=("test_no_route_returns_a_stored_row_without_the_operator_bearer",
                       "test_no_request_without_the_operator_bearer_changes_the_store",
                       "test_what_one_visitor_posts_never_comes_back_to_another",
                       "test_the_operator_still_reads_persists_and_updates_the_queue",
                       "test_the_queue_fails_closed_where_no_operator_token_is_configured",
                       "test_the_store_has_exactly_the_tables_this_gate_plants")),
        # WORKSPACE-V2 — the redesign's engine gates (one company per
        # workspace, keyed by CUI) on the REAL create_app() and the REAL
        # identifier: G1 a file lands in the company its header names, G2 the
        # period is the document's, G3 the same file twice is stored,
        # analysed and counted once, G4 no period without an analysed file
        # (plus the creator census) and a same-month re-upload replacing the
        # month only once its run succeeds, G7 identify -> commit -> the five
        # stages -> the served dashboard, G8 archive-never-delete and the
        # plan-scoped rollback. The browser half (G1 G2 G3 G5 G6 G8) rides
        # `vitest`; the e2e half needs a hermetic build (gates.md). Floor 29
        # = the measured 24 + 5, exact (2026-09-26: + the same-month takeover
        # gates, the no-CUI refusal, the dead-letter replay, the card's
        # confirmed extra). Review round 4 (2026-10-02): the .pdf-NAMED twins
        # of G1 and of the G4 cross-company wall — a workbook named .pdf is
        # identified by its bytes, lands in the company its header names and
        # never replaces another company's month. Measured 31, floor 31.
        # Review round 5 (2026-10-02): the PDF twins, in the two byte shapes
        # the pipeline reads as a PDF and the identifier did not — G1 through
        # the real routes (5 rows: the declared MIME type is handed to the
        # identifier), the G4 wall under 8 (shape, name, MIME) rows with a
        # clean-PDF control, the same company's PDF still replacing the month
        # (2 — the pipeline READS both shapes), and the month's own document
        # of a company without a CUI read with its `mime_type` (1); /commit
        # hands the MIME type over too (a pre-CUI workspace takes the CUI of
        # its own PDF, 2 rows). Measured 49, floor 49.
        # Plant log: docs/engine_book/gates.md.
        Gate("workspace-v2",
             [PY, "-m", "pytest", "tests/engine/test_workspace_v2_gates.py",
              "tests/engine/test_no_empty_period_creators.py", "-q"],
             work_junit=True, floor=49, units="tests",
             canaries=("test_g1_an_agras_file_dropped_on_a_scandia_page_lands_in_agras",
                       "test_g1_an_agras_workbook_named_pdf_is_identified_by_its_bytes_and_lands_in_agras",
                       "test_g1_an_agras_pdf_is_identified_on_the_branch_the_pipeline_reads_it_on_and_lands_in_agras",
                       "test_g1_a_workspace_from_before_cuis_takes_the_cui_of_its_own_pdf_whatever_mime_named_it",
                       "test_g4_a_same_month_file_of_another_company_never_replaces_the_month",
                       "test_g4_a_same_month_pdf_of_another_company_never_replaces_the_month",
                       "test_g4_a_same_month_pdf_of_the_same_company_still_replaces_the_month",
                       "test_g4_the_month_of_a_company_without_a_cui_is_its_own_pdfs_whatever_mime_named_it",
                       "test_g2_a_2017_file_name_whose_period_line_says_2025_is_2025",
                       "test_g3_the_same_file_twice_is_stored_analysed_and_counted_once",
                       "test_g4_the_production_check_finds_the_empty_periods_of_a_snapshot",
                       "test_g4_a_same_month_reupload_whose_run_fails_leaves_the_month_serving_the_first_analysis",
                       "test_g7_drop_one_tap_five_stages_then_the_served_dashboard",
                       "test_g8_the_migration_archives_and_db_restore_reverts_it_exactly")),
        # RADAR: the cross-period spine, the twelve detectors, and the six
        # defects an adversarial read found in them. Named separately from
        # `pytest` because every one of those six shipped GREEN — each
        # produced a number a reader would have believed rather than a
        # crash, so a suite that only asks "did it run" cannot see them.
        # The canaries are one per repair. Floor 100 = the measured 102
        # tests, rounded down. Plant log: docs/engine_book/gates.md
        Gate("radar",
             [PY, "-m", "pytest",
              "tests/engine/test_radar_series.py",
              "tests/engine/test_radar_detectors.py",
              "tests/engine/test_radar_detector_pack.py",
              "tests/engine/test_radar_detector_repairs.py",
              "tests/engine/test_radar_spine_join.py",
              "tests/engine/test_radar_detector_lane.py",
              "tests/engine/test_radar_wiring.py",
              "tests/engine/test_radar_ship_blockers.py",
              "tests/engine/test_caen_one_authority.py",
              "tests/engine/test_e8_jurisdiction_blindness.py", "-q"],
             work_junit=True, floor=180, units="tests",
             canaries=("test_a_part_year_never_produces_a_cutoff_finding",
                       "test_a_gap_inside_the_quiet_stretch_breaks_the_run",
                       "test_the_jurisdiction_guard_sees_the_lower_case_literal",
                       "test_a_book_with_no_movement_column_omits_the_movement_figure",
                       "test_an_impact_that_renders_the_same_on_both_sides_is_refused",
                       "test_a_concentration_below_the_material_floor_does_not_surface",
                       "test_a_fictional_detector_added_through_yaml_alone_surfaces",
                       "test_a_served_row_carries_no_movement_and_no_opening",
                       "test_a_distribution_family_counts_each_booked_amount_once",
                       "test_the_row_carries_the_RULAJ_and_not_the_sume_totale",
                       "test_the_two_paths_agree_on_every_real_book",
                       "test_with_the_lane_off_the_payload_does_not_move",
                       "test_the_flag_is_key_material",
                       "test_the_lane_produces_ranked_findings_on_a_real_book",
                       "test_without_its_flag_the_whole_surface_is_absent",
                       "test_caen_is_read_from_the_org_table",
                       "test_the_line_items_travel_on_the_period_input",
                       "test_no_two_surfaced_findings_state_the_same_exposure",
                       "test_every_published_money_figure_equals_the_served_figure",
                       "test_no_double_declares_a_column_any_table_does_not_have")),
        # FORECAST: the route that made the projection reachable, and the
        # invariant it must keep on the way out. Named separately from
        # `pytest` because the failure this covers was not a red test —
        # the engine, the serving contract, the reader and the renderer
        # were all green and the feature was simply not mounted anywhere.
        # Floor 20 = the measured 21 tests, rounded down.
        # Plant log: docs/engine_book/gates.md
        Gate("forecast-route",
             [PY, "-m", "pytest", "tests/engine/test_forecast_route.py", "-q"],
             # plan/2 B6: floor 30 -> 45 (measured 49) with the fp1.2 canaries
             work_junit=True, floor=45, units="tests",
             canaries=("test_the_route_is_mounted_on_the_real_app",
                       "test_get_equals_post_with_the_default_body",
                       "test_the_post_body_binds_at_module_scope",
                       "test_an_invalid_request_is_422_with_code_text_and_field",
                       "test_a_base_plan_that_draws_an_unpriceable_line_is_served_partially_and_says_so",
                       # plan/2 B4b (28.3 B4): GET through create_app on the
                       # four books at horizons 3 and 5 answers 200 with no
                       # clause violation, the pool drivers expanded
                       "test_get_through_the_real_app_answers_200_with_no_clause_violation",
                       "test_the_route_resolves_the_workspace_and_scopes_the_read_to_it",
                       "test_the_period_read_filters_on_the_resolved_workspace",
                       "test_an_anonymous_call_is_refused",
                       "test_a_horizon_the_engine_does_not_offer_is_refused_by_name",
                       "test_no_projected_figure_carries_actual_provenance",
                       "test_every_projected_line_names_a_driver_or_a_stated_convention")),
        # ── plan/2 B0 (plan_contract_v2 28.3): forecast gate wiring ──────
        # Existing, already-passing forecast suites that no named gate ran:
        # they rode the whole-suite `pytest` gate, where a collapse of one
        # file hides inside 1,500 tests. Registered by name so the plan/2
        # batches extend gates that exist. Each is registration_only in
        # docs/engine_book/plan_gates.json (contract 0.5). Floors are the
        # counts measured at registration, rounded down. Later batches
        # extend these entries under their own anchors.
        Gate("forecast-model",
             [PY, "-m", "pytest", "tests/engine/test_forecast_model.py",
              # plan/2 B2: the calendar and year-to-date tax (contract 6.1,
              # 6.3) join this gate; floor re-measured over both files (the
              # F1 matrix axis became monthly_months {12, 24}, so the model
              # file itself holds 20 fewer parametrised cases than at B0).
              "tests/engine/test_forecast_timeline_tax.py",
              # plan/2 B5: the working-capital unwind of contract 6.2 joins
              # this gate (28.3 B5 "command extended"); floor re-measured.
              "tests/engine/test_forecast_wc_unwind.py", "-q"],
             work_junit=True, floor=244, units="tests",
             canaries=("test_f1_every_projected_period_closes_to_zero",
                       "test_f1_one_cent_is_enough_to_red_it",
                       "test_f1_the_cash_flow_statement_articulates_the_balance_sheet",
                       "test_f3_no_clock_is_read_and_the_calendar_comes_from_the_book",
                       # plan/2 B2
                       "test_a_loss_month_then_profit_months_is_taxed_on_the_years_result",
                       "test_every_period_is_charged_the_tax_on_its_year_to_date_result",
                       # plan/2 B5
                       "test_agras_receivables_follow_the_unwind_formula_every_month",
                       "test_retail_month_one_cash_moves_by_at_most_a_month_of_the_flow_change",
                       "test_the_calendar_is_monthly_months_then_one_period_per_plan_year",
                       # one-EBITDA ruling (stage G1): f6's CONSTRUCTED
                       # misread witness — every committed book now misses
                       # 121 only by its bridged 711 (gates.md
                       # "net-income-anchor-witness")
                       "test_f6_the_constructed_misread_opens_on_the_anchor_and_names_nothing",
                       "test_f6_scope_has_a_miss_that_is_not_the_stock_variation")),
        # ── owner ruling 2026-09-26, design A8 (stage G1): the anchor gates
        # the account-121 bridge made vacuous. Every committed book that
        # misses account 121 now misses it by its net 711, which the
        # statement NAMES (derived from 121), so "the build-up + the bridged
        # 711" would equal the anchor on all of them. The CONSTRUCTED
        # witness `closed_no_activity` (net-711-rule: no 711 postings, 121
        # above its accounts by 2,000.00) is served through the real write
        # path; with no such witness these files are RED (TC-3). Measured 81
        # tests. Plant log: gates.md "net-income-anchor-witness".
        Gate("net-income-anchor-witness",
             [PY, "-m", "pytest", "tests/engine/test_one_concept_one_value.py",
              "tests/engine/test_rebuild_net_income_anchor.py", "-q"],
             work_junit=True, floor=72, units="tests",
             canaries=("test_every_book_carries_both_net_income_views_and_an_anchor",
                       "test_a_constructed_no_711_misread_fires_the_override_through_every_seam",
                       "test_the_firing_scope_carries_a_divergence_that_is_not_the_stock_variation",
                       "test_enough_books_actually_fire_the_override")),
        Gate("forecast-serving-boundary",
             [PY, "-m", "pytest", "tests/engine/test_forecast_serving_boundary.py", "-q"],
             work_junit=True, floor=60, units="tests",
             canaries=("test_the_guard_is_silent_on_all_four_committed_books",
                       # plan/2 B6 (3.13): the real POST bytes, per want key
                       "test_no_actual_provenance_on_real_post_bytes",
                       "test_the_committed_fp12_served_fixture_is_what_the_real_route_serves",
                       "test_every_real_book_serves_a_whole_projection_at_every_horizon",
                       "test_the_projected_balance_sheet_closes_to_the_cent_on_the_real_book")),
        Gate("forecast-drivers",
             [PY, "-m", "pytest", "tests/engine/test_forecast_drivers.py", "-q"],
             work_junit=True, floor=140, units="tests",
             canaries=("test_b2_absent_is_none_and_never_zero",
                       "test_f1_the_package_contains_no_model_call_and_no_place_for_one",
                       "test_j8_an_absent_driver_never_becomes_a_number_in_the_handover")),
        Gate("forecast-ai-write-path",
             [PY, "-m", "pytest", "tests/engine/test_forecast_no_ai_write_path.py", "-q"],
             work_junit=True, floor=15, units="tests",
             canaries=("test_the_scan_is_not_vacuous_and_names_what_it_covers",
                       "test_importing_the_forecast_packages_loads_no_model_surface",
                       "test_plant_a_forecast_module_that_imports_a_model_surface_and_it_reds")),
        Gate("plan-gate-census", [PY, "scripts/check_plan_gates.py"],
             work_rx=r"GATE-WORK plan-gate-census units=(\d+)", floor=6,
             units="plan gate entries",
             canaries=("PLAN-GATE CENSUS (plan_contract_v2 F10)",
                       "coverage of the 18 contract rows")),
        # ── end plan/2 B0 ────────────────────────────────────────────────
        # ── plan/2 B2 (plan_contract_v2 28.3): forecast-base-parity ──────
        # Delta mode (B2, B3): today's engine against the B0 reference. Re-
        # pointed by plan/2 B4b to PARITY MODE (contract 5.3): the engine at
        # revenue_growth 0 and inflation 0 against base_b3_growth0.json (the
        # B3 engine over the repaired books at growth 0) on the four books,
        # total_years 5, windows 12 and 24; revenue exact, every other cell
        # within a bound rendered from the run and printed beside it.
        Gate("forecast-base-parity",
             [PY, "-m", "pytest", "tests/engine/test_forecast_base_parity.py", "-q"],
             work_rx=r"GATE-WORK forecast-base-parity units=(\d+)", floor=12000,
             units="(line, period) and plan-year cells compared",
             canaries=("SCOPE forecast-base-parity (parity mode, plan/2 B4b)",
                       "366-day plan year per book",
                       "bound inputs")),
        # ── end plan/2 B2 ────────────────────────────────────────────────
        # ── plan/2 B3 (plan_contract_v2 28.3): one driver authority and tier
        # pedigree. forecast-authority (section 4): the integers the two
        # driver packages hold for every shared concept on the four books.
        # forecast-defaults, engine half (F3, 3.3/3.4/R16): every driver's
        # tier from its ladder with its evidence, absent drivers project,
        # the no_statutory_tax_rate refusal (engine and GET 422), and the
        # jurisdiction source per corpus book. B6 extends forecast-defaults
        # over served bytes (test_forecast_defaults_f3.py).
        Gate("forecast-authority",
             [PY, "-m", "pytest", "tests/engine/test_forecast_driver_authority.py", "-q"],
             work_rx=r"GATE-WORK forecast-authority units=(\d+)", floor=140,
             units="shared-concept comparisons",
             canaries=("SCOPE forecast-authority (plan/2 B3, contract 4)",
                       "covered concepts",
                       # B3 repair: the hand-over and the SYNTHETIC tying
                       # books (one tax derivation, contract 4)
                       "each concept compared alone and after the hand-over")),
        Gate("forecast-defaults",
             [PY, "-m", "pytest", "tests/engine/test_forecast_tier_ladders.py", "-q"],
             work_rx=r"GATE-WORK forecast-defaults units=(\d+)", floor=150,
             units="drivers checked",
             canaries=("SCOPE forecast-defaults (engine half, plan/2 B3)",
                       "jurisdiction source per corpus book",
                       "responses with an absent driver that projected",
                       # B3 repair: rungs passed over on built shapes, and
                       # the ratio table's own days value (R8)
                       "built step shapes",
                       "ratio-table quotes checked")),
        # ── end plan/2 B3 ────────────────────────────────────────────────
        # ── plan/2 B4a (plan_contract_v2 5.1 / 28.3 B4; owner ruling
        # 2026-09-18, the 609/709 double count): statements-anchor-gap.
        # On every corpus book, the Scandia regression baseline and any
        # PLAN_LOCAL_XLSX book, |account 121 - reconstruction| is printed
        # and must be within the floor rendered from
        # packs/ro/statements_anchor.yaml#anchor_gap and the book (the
        # cent tolerance plus the 711/712 turnover a mirrored exporter
        # hides); every mirrored 609/709 row enters its bucket as the
        # reduction it is under the convention its document decided.
        Gate("statements-anchor-gap",
             [PY, "-m", "pytest", "tests/engine/test_statements_anchor_gap.py", "-q"],
             work_rx=r"GATE-WORK statements-anchor-gap units=(\d+)", floor=65,  # 45 -> 58: + the four decision-rule documents (B4 repair); 58 -> 65: + the folds and the two constructed witnesses (one-EBITDA ruling, measured 70)
             units="books judged, contra rows checked, metamorphic comparisons, folds and constructed witnesses",
             canaries=("SCOPE statements-anchor-gap (plan/2 B4a, contract 5.1)",
                       "floor from packs/ro/statements_anchor.yaml#anchor_gap",
                       "convention per document",
                       "mirrored contra rows checked",
                       # one-EBITDA ruling (2026-09-26): the step BEFORE the
                       # fold is judged, the fold held, and two SYNTHETIC
                       # misreads prove the judge still reds.
                       "fold per book (ruling 2026-09-26)",
                       "SYNTHETIC g5_residual")),
        # ── end plan/2 B4a ───────────────────────────────────────────────
        # ── owner ruling 2026-09-26: net-711-rule ────────────────────────
        # Net 711 ("Variația stocurilor de produse") is MEASURED off the
        # trial balance (stock_variation.measure/decide), never the gross
        # memo (Σ sume totale C — the production stocked on a closed book),
        # never a 0.00 standing in for an absent account-121 anchor. Twelve
        # constructed books (OPEN, CLOSED-no-activity, CLOSED-bridge, MIXED,
        # unanchored, G4 unread, G4 total row, a distinct prefix-coded
        # account, G5, G6, bridge+722, and G7 — rows read by an older
        # trial-balance parser, design A10) through the offline
        # composition; four through the real write path, GET /api/period
        # and the briefing rebuild; a legacy envelope refuses; an envelope
        # restamped by an older reader refuses reprocess_required; five
        # in-file plants. Measured 139 units (159 with the unanchored_unbalanced
        # witness, critic fixer round 1). Plant log: gates.md "net-711-rule".
        Gate("net-711-rule",
             [PY, "-m", "pytest", "tests/engine/test_net_711_rule.py", "-q", "-s"],
             work_rx=r"GATE-WORK net-711-rule units=(\d+)", floor=90,
             units="constructed books judged, served seams compared, refusals and plants",
             canaries=("SCOPE net-711-rule (stock_variation.measure/decide, owner ruling 2026-09-26)",
                       "NET711-BOOKS: bridge_with_722, closed_bridge, closed_no_activity, "
                       "distinct_prefix_account, g4_double_read, g4_unread, g5_residual, "
                       "g6_uncleared, g7_older_parser, mixed, open, unanchored, unanchored_unbalanced",
                       "NET711-PLANTS: serve-the-gross-memo, absent-anchor-to-zero, drop-guard-g6, "
                       "drop-guard-g7, rebuild-forgets-the-evidence")),
        # ── design A8 (stage G1): the account-121 cross-check and its D6
        # diagnosis close by construction on every corpus book since the
        # 711 term is the bridge. Constructed witnesses (net-711-rule's
        # misreads: closed_no_activity, g4_unread, g5_residual,
        # g6_uncleared, g7_older_parser) through the real write path and
        # GET /api/period keep them falsifiable; two in-file plants.
        # Measured 30 units. Plant log: gates.md "p121-witness".
        Gate("p121-witness",
             [PY, "-m", "pytest", "tests/engine/test_p121_cross_check_witness.py", "-q", "-s"],
             work_rx=r"GATE-WORK p121-witness units=(\d+)", floor=26,
             units="cross-checks judged on constructed books, plants",
             canaries=("SCOPE p121-witness (canonical_bs p121_cross_check + D6, design A8): "
                       "2 folded books, 5 witnesses",
                       "closed_no_activity (121 122000.0 vs class 7 - class 6 120000.0)")),
        # ── owner ruling 2026-09-26, design A8 (stage G): the ENGINE halves
        # of one-ebitda / turnover-denominator / refusal-carries. Every
        # engine surface — the assembled P&L and its aliases, the served
        # reconciliation line and bridge, GET /api/period's metrics block,
        # the stored metric rows, the ratio table, the credit model, the
        # methodology views, FactsGateway (Capsule get_facts / advisory /
        # radar), the valuation, the Section 9 benchmark, the forecast's
        # year 0, the briefing's citable ratios and the confidence roll-up —
        # carries THE ONE EBITDA, divides net turnover, and carries a refused
        # EBITDA as the 711 refusal. Four corpus books and six CONSTRUCTED
        # books (net-711-rule) through the real write path and GET
        # /api/period. Measured 208 / 168 / 146. Plant logs: gates.md
        # "one-ebitda-engine", "turnover-denominator-engine",
        # "refusal-carries-engine".
        Gate("one-ebitda-engine",
             [PY, "-m", "pytest", "tests/engine/test_one_ebitda_engine.py", "-q"],
             work_rx=r"GATE-WORK one-ebitda-engine units=(\d+)", floor=190,
             units="engine surfaces compared with the served EBITDA / EBIT",
             canaries=("SCOPE one-ebitda-engine: 8 served books",
                       "ONE-EBITDA-ENGINE surfaces: 20 EBITDA + 6 EBIT per book")),
        Gate("turnover-denominator-engine",
             [PY, "-m", "pytest", "tests/engine/test_turnover_denominator_engine.py", "-q"],
             work_rx=r"GATE-WORK turnover-denominator-engine units=(\d+)", floor=150,
             units="engine revenues and margins checked against net turnover",
             canaries=("SCOPE turnover-denominator-engine: 8 served books",
                       "refused by the one margin rule on every displayed surface: realestate")),
        Gate("refusal-carries-engine",
             [PY, "-m", "pytest", "tests/engine/test_refusal_carries_engine.py", "-q"],
             # fixer round 2: floor raised from 160 with the Piotroski score, the
             # balance sheet's current-year result and the briefing facts (192).
             # critic fixer round 1 (third round): the unanchored_unbalanced
             # witness and total equity short by the refused result (335).
             # critic fixer round 2: the real developer with its 121 row
             # deleted from the file (realestate_no121) and every other
             # reader of total equity — briefing facts, methodology,
             # FactsGateway / Capsule, insights, R4, findings (measured 521).
             # critic round 3 fixer (2026-09-28): the sector benchmark (12k),
             # the related-party order (12e both sides), the sub-scores worded
             # on their own causes, and rows persisted before the refusal —
             # GET metrics[] / the typed ratios / a stored valuations row / the
             # narrator's rows (13) (measured 663).
             work_rx=r"GATE-WORK refusal-carries-engine units=(\d+)", floor=600,
             units="engine surfaces checked to refuse with the 711 reason",
             canaries=("SCOPE refusal-carries-engine: refused books g6_uncleared "
                       "(account_121_opening_not_cleared); realestate_no121 (account_121_anchor_absent); "
                       "unanchored (account_121_anchor_absent)",
                       # fixer round 1: the net result refuses with 711 when there is no 121
                       "NET-RESULT refused (no account 121): unanchored, unanchored_unbalanced, "
                       "realestate_no121",
                       # critic fixer round 1: total equity short by the refused result
                       "EQUITY short by the refused result: unanchored_unbalanced, realestate_no121; "
                       "complete: g6_uncleared, unanchored",
                       # critic fixer round 2: every other reader of total equity
                       "EQUITY-READERS (briefing facts + Debt/Equity, methodology, FactsGateway.equity, "
                       "Capsule, insights, R4, findings, sector benchmark): unanchored (served), "
                       "g6_uncleared (served), unanchored_unbalanced (refused), realestate_no121 (refused)")),
        # ── owner spec 2026-09-26 P1 (inventory days), design B1-B5 ────────
        # The ONE served block (engine.ratios.inventory_days): the split by
        # stock type reconciles to the served inventory_net to the cent,
        # every days figure is its stock over its flow (recomputed from the
        # evidence), an average is an average and a snapshot says "o singură
        # zi", a refused 711 / the developer refuse, the claim policy, the
        # seasonality flag, GET /api/period serves it once. Measured 152
        # units. Plant log: gates.md "inventory-days".
        Gate("inventory-days",
             [PY, "-m", "pytest", "tests/engine/test_inventory_days.py", "-q", "-s"],
             work_rx=r"GATE-WORK inventory-days units=(\d+)", floor=140,
             units="evidence accounts reconciled, bases, blocks served",
             canaries=("SCOPE inventory-days: corpus books agras, carniprod, realestate, retail",)),
        # One metric name, one formula (design B4): dio / inventory_turnover /
        # ccc / dpo across the ratio table, the metric rows, the efficiency
        # block, the forecast driver, the trade-float insight, the methodology
        # views, the radar and the sector row — plus a source scan of
        # src/engine AND of the frontend's TypeScript (the browser's
        # computeRatios had its own ÷ total operating expense) — and the
        # cockpit's BANK EXPORT through create_app (the one block verbatim, the
        # DIO lever on it, no DPO but the one), the forecast's payables labels
        # (never "DPO" over cost of sales) and the methodology FILE. ONE DAY
        # COUNT (2026-09-27): three non-365 served periods (a leap year, two
        # 1 Jan-30 Jun books) — DSO / DPO / CCC recomputed from operands on
        # the served periodDays against the table, metrics[], the efficiency
        # block and the trade-float insight (whose printed operands must
        # reproduce its DPO), and the bank export on a 366- and a 181-day
        # period (the DIO lever restated on the plan's 365-day year); the
        # block's printed days on the ratio table's quantization, and the
        # bank export's DIO lever on the block's closing_value_q. Measured
        # 98. Plant log: gates.md "one-metric-one-formula".
        Gate("one-metric-one-formula",
             [PY, "-m", "pytest", "tests/engine/test_one_metric_one_formula.py", "-q", "-s"],
             # release r-rulings (2026-09-28): the trade float prints DSO / DPO
             # as the Ratios table does; fixer round 3 (coordinator's ruling,
             # one figure per report): the GAP prints its own served figure
             # on the same precision, with the rounding note iff the printed
             # DSO − DPO parts from it — the Scandia G7 witness is where they
             # part — and the pack's `rounded` variant carries en.json's
             # roundedDays.note word for word (measured 121).
             work_rx=r"GATE-WORK one-metric-one-formula units=(\d+)", floor=110,
             units="surfaces compared with the one authority",
             canaries=("SCOPE one-metric-one-formula: corpus books agras, carniprod, realestate, retail",)),
        # INVENTORY DAYS ON EVERY SURFACE (owner spec 2026-09-26 P1, design
        # B4): the Ratios tile and drawer print the served split (three legs
        # with their accounts, alte stocuri, the basis, seasonality); the CFO
        # report, its workbook and the cockpit's bank export print ONE block,
        # byte-identical in the two bank-bound documents; the Products SKU
        # figure is "Zile de rotație SKU" and never enters the company CCC;
        # a listed company's reported basis lives under its own key; the chat
        # is handed the claim policy; the DIO card never points at the
        # filed-basis sector row; the /report page prints the split under
        # section 5; the tile, the split's total and the report print ONE
        # string for the figure; a comparison across two bases prints the
        # refusal, no figure, no tone; the cycle chart's period-end DIO row
        # states the period-end term's own basis (chartsAgreeWithCards) and
        # every cycle term prints its card's string / the block's
        # closing_value_q; the bank export's DIO lever prints the split's
        # period-end figure character for character (EN, RO); a snapshot
        # period's DIO reading never says "on average" (the workbook row);
        # ONE CCC FIGURE PER REPORT (coordinator's ruling 2026-09-28,
        # replacing the merge contract's sum of the printed terms): the cycle
        # chart's CCC bar prints the CCC card's string, each term its own
        # served figure, and ONE rounding note iff the printed terms do not
        # foot — no tooltip figure, no second total in the caption
        # (reportCharts G-C1b, chartsAgreeWithCards §A1b; POSITIVE CONTROL
        # retail); the chat snapshot carries the stock-claim rule line on a
        # snapshot-basis period, the inventory-days total with its basis
        # label and the one EBITDA with its 711 / 72x components or the
        # engine's refusal words (chat-llm not redeployed this release).
        # Rendered over served bytes (vitest). Measured 191 tests, floor 185.
        # Plant log: gates.md "inventory-days-surfaces".
        Gate("inventory-days-surfaces",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/inventoryDaysSplit.test.ts",
              "frontend/lib/__tests__/inventoryDaysRatiosTab.test.tsx",
              "frontend/lib/__tests__/inventoryDaysDocuments.test.ts",
              "frontend/pages/cfo/__tests__/productsSkuDaysNotDio.test.tsx",
              "frontend/lib/__tests__/publicInventoryDays.test.ts",
              "frontend/pages/cfo/__tests__/chatSnapshotInventoryDays.test.ts",
              "frontend/lib/__tests__/sectorBenchmark.test.tsx",
              "frontend/components/cfo/simple/__tests__/annotateTerms.test.tsx",
              "frontend/pages/cfo/__tests__/comprehensiveReportInventoryDays.test.tsx",
              "frontend/lib/__tests__/chartsAgreeWithCards.test.ts",
              "frontend/lib/__tests__/reportCharts.test.ts",
              "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=185,
             units="surface tests (tile, drawer, report, workbook, bank export, products, public, chat, benchmark, cycle chart)",
             canaries=("the tile prints every leg with its accounts, alte stocuri and the basis",
                       "the cycle prints ONE CCC — the card's string; the rounding note iff the printed terms do not foot",
                       "POSITIVE CONTROL: retail's printed terms miss the card's cycle (the note is printed); another book foots (none is)",
                       "the snapshot-basis period carries ONE rule line and the total with its basis label",
                       "the one EBITDA with its 711 / 72x components, or the engine's refusal words",
                       "the bank export (EN) prints the report's block byte for byte",
                       "labels the SKU figure as SKU turnover days and takes CCC from the trial balance",
                       "replaces the company dio with the reported-basis row under its own key",
                       "the filed-basis inventory row wears the owner's label, no second note")),
        # THE SPLIT ADDS UP (owner spec 2026-09-26 P1.1, design B1): on the
        # ten corpus books that carry stock, through the real write path and
        # GET /api/period, Σ legs + alte stocuri = the balance sheet's stock
        # to the cent against the gate's OWN parse of each file; every
        # class-3 account in the part the ruling gives it (39x against its
        # group); a split that does not reconcile refuses; Scandia FY2025 as
        # stored today reconciles its 55,341,817.75. Measured 245. Plant
        # log: gates.md "inventory-split-reconciles".
        Gate("inventory-split-reconciles",
             [PY, "-m", "pytest", "tests/engine/test_inventory_split_reconciles.py", "-q", "-s"],
             work_rx=r"GATE-WORK inventory-split-reconciles units=(\d+)", floor=230,
             units="stock accounts, books, openings and refusals checked",
             canaries=("SCOPE inventory-split-reconciles: corpus books saga_10_col, saga_10_col_agras",)),
        # AN AVERAGE IS AN AVERAGE (P1.2, design B2): the two-year-end
        # average only with the fiscal-year opening, labelled "media
        # soldurilor la 1 ianuarie și 31 decembrie"; the snapshot — a
        # 4-column file, an undated opening, every period written before the
        # evidence, Scandia as stored — "stoc la 31 decembrie — o singură
        # zi"; the monthly basis through create_app with twelve month-ends;
        # food/FMCG flagged on both year-end bases, never on the monthly;
        # every served-rebuild seam (Capsule, firm lane, radar, the period
        # reader, a FactsGateway on the rebuilt envelope) serving the page's
        # block on the twelve-month workspace; a monthly file whose si is the
        # month opening (convention A) the snapshot; the upload-time block
        # and the narrator carry the org's seasonality; a 4-pair export where
        # B ties A dates its si only by a zero class 6/7 opening; a source
        # with no trial-balance rows (model extraction, statutory return)
        # says so, never "recomputed when reprocessed"; an unreconciled month
        # never enters the monthly average. Measured 119. Plant log:
        # gates.md "inventory-basis-label".
        Gate("inventory-basis-label",
             [PY, "-m", "pytest", "tests/engine/test_inventory_basis_label.py", "-q", "-s"],
             work_rx=r"GATE-WORK inventory-basis-label units=(\d+)", floor=95,
             units="bases, labels, seasonality flags and surfaces checked",
             canaries=("SCOPE inventory-basis-label: corpus books saga_10_col",)),
        # NEVER "SLOW" ON ONE DAY (P1.5, design B5): agras and two stock-rise
        # variants through the real write path and the served comparatives —
        # no slow claim on the snapshot, the average's claim cites every leg
        # and the basis, a move across bases is basis_differs, improvements
        # kept, gateway/narrator/prompt agree, no served text of a snapshot
        # period calls the stock slow; no delta (value, % or direction)
        # served across two bases. Measured 30. Plant log: gates.md
        # "stock-claim-policy".
        Gate("stock-claim-policy",
             [PY, "-m", "pytest", "tests/engine/test_stock_claim_policy.py", "-q", "-s"],
             work_rx=r"GATE-WORK stock-claim-policy units=(\d+)", floor=28,
             units="claims withheld or cited, policy surfaces and served bodies scanned",
             canaries=("SCOPE stock-claim-policy: corpus agras + tmp variants",)),
        # THE FILED BASIS STAYS APART (P1.3, design B3) — engine half: five
        # books through create_app, CAEN 1011; no sector band on a card built
        # on the split, the filed row recomputed as stock ÷ net turnover,
        # nothing of the split in the sector document. Measured 30.
        Gate("benchmark-basis-separation-engine",
             [PY, "-m", "pytest", "tests/engine/test_benchmark_basis_separation_engine.py", "-q", "-s"],
             work_rx=r"GATE-WORK benchmark-basis-separation-engine units=(\d+)", floor=30,
             units="split cards, filed rows and sector documents checked",
             canaries=("SCOPE benchmark-basis-separation-engine:",)),
        # — and the browser half: the Benchmark page's filed row, the DIO and
        # cycle tiles, the CFO report — as served and against a document that
        # hangs the filed quartiles on the split's cards (the browser refuses
        # it). Measured 7 tests. Plant log: gates.md
        # "benchmark-basis-separation".
        Gate("benchmark-basis-separation",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/benchmarkBasisSeparation.test.tsx", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=7,
             units="surface tests (page row, tiles, report)",
             canaries=("the DIO, inventory-turnover and cycle tiles — even when a document serves one",
                       "sector section without the split, the split without a sector row — as served")),
        # ── owner ruling 2026-09-26, design A6: valuation-one-ebitda ────
        # EV/EBITDA multiplies the ONE EBITDA (never the revision-2 fallback
        # that rebuilt a second one from the incomeStatement mirror on 0.0);
        # a refused EBITDA refuses EV/EBITDA with its cause; the developer is
        # routed by the ONE margin rule, not by its EBITDA sign, and its
        # value is pinned to the base-commit measurement; NOI proxy = EBITDA
        # − net 711; saved overrides stamped with the definition; a saved row
        # whose EBITDA is null keeps the refusal. Measured 15 tests; 21 with
        # the stored-valuations-row law (critic fixer round 1: a row on
        # another EBITDA, or over a refused one, is never the EBITDA and never
        # makes EV/EBITDA primary — GET /api/period and briefing regenerate).
        # Plant log: gates.md "valuation-one-ebitda".
        Gate("valuation-one-ebitda",
             [PY, "-m", "pytest", "tests/engine/test_valuation_one_ebitda.py", "-q"],
             # critic round 3 fixer (2026-09-28): one industry key for every
             # served valuation (GET and the regenerate route) — 23 tests.
             work_junit=True, floor=21, units="tests",
             canaries=("test_the_developer_is_valued_on_its_assets_by_the_margin_rule_not_by_its_ebitda_sign",
                       "test_one_valuation_choice_one_industry_key",
                       "test_a_refused_ebitda_refuses_every_ev_ebitda_figure_with_its_cause",
                       "test_saving_an_override_stamps_it_and_get_serves_it_current",
                       "test_a_stored_row_on_the_previous_ebitda_is_refused_when_nothing_recomputes",
                       "test_a_stored_row_never_stands_in_for_a_refused_ebitda",
                       "test_the_briefing_regenerate_never_cites_a_stored_row_on_the_previous_ebitda")),
        # ── owner ruling 2026-09-26, design A6: firm-covenant-one-ebitda ─
        # An EBITDA covenant tests THE ONE EBITDA off the served assembled
        # P&L (never the gateway's methodology `ebitda.reported`, net 711
        # outside), cites net 711 / net 72x / EBITDA-before beside the
        # headroom, and a refused EBITDA is a stated gap, never a test. The
        # four tests live in test_firm_attention.py (which the `pytest`
        # gate also runs); named here so a collapse of the selection reds.
        # Plant log: gates.md "firm-covenant-one-ebitda".
        Gate("firm-covenant-one-ebitda",
             [PY, "-m", "pytest", "tests/engine/test_firm_attention.py", "-q",
              "-k", "ebitda or cited_money_fact"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_an_ebitda_covenant_tests_the_one_ebitda_and_cites_its_components_beside_the_headroom",
                       "test_a_refused_ebitda_is_a_stated_gap_never_a_covenant_test")),
        # ── owner ruling 2026-09-26, design A9: briefing-definition ──────
        # Every stored briefing is stamped with the EBITDA definition it was
        # written under (stage_persist_narrative + /briefing/regenerate) and
        # GET /api/period serves `briefing.definition` — a pre-ruling
        # (unstamped) briefing as written under the previous definition,
        # with the note the page hides it behind. The column has its
        # migration ending in the PostgREST NOTIFY. Real create_app and the
        # real narrate write over the tenancy double. Measured 8 units; 9
        # with the generic note pinned on an earlier revision's stamp
        # (deploy-readiness review of feat/rulings-2, 2026-09-29).
        # Plant log: gates.md "briefing-definition".
        Gate("briefing-definition",
             [PY, "-m", "pytest", "tests/engine/test_briefing_definition.py", "-q", "-s"],
             work_rx=r"GATE-WORK briefing-definition units=(\d+)", floor=8,
             units="stamps written, statuses served, migration checks",
             canaries=("SCOPE briefing-definition: GET /api/period over the tenancy double",)),
        # ── owner ruling 2026-09-26, design A9: reprocess-periods-definition
        # The deploy's reprocessing tool (scripts/reprocess_periods_
        # definition.py) re-runs a stored period through the pipeline's own
        # stages with the model guarded out and no quota path: the dry run
        # writes nothing and reports anchor / book state / net 711 / old vs
        # new EBITDA / credit letter; the apply leaves the evidence + stamp +
        # one-EBITDA metric rows, carries council alerts and never rewrites
        # the briefing; a second apply is a no-op; a model-needing document,
        # a moved month and an unruled turnover move are refused unwritten.
        # Corpus agras through the workspace-v2 tenancy double. Measured 31;
        # 53 with the valuations row (critic fixer round 1: old vs new
        # ebitda_used in the dry run, never `current` on a row carrying
        # another EBITDA, the user's override row left as the user's).
        # Plant log: gates.md "reprocess-periods-definition".
        Gate("reprocess-periods-definition",
             [PY, "-m", "pytest", "tests/engine/test_reprocess_periods_definition.py", "-q", "-s"],
             # critic round 3 fixer: the apply reads the valuations row back (56).
             # owner rulings R2 / R3 (2026-09-28): a period on the PREVIOUS
             # definition stamp is reprocessed, the dry run prints the stamp,
             # net provisions and the 7411 inside turnover, and a turnover move
             # of exactly the placed 7411 is the ruling (measured 85).
             work_rx=r"GATE-WORK reprocess-periods-definition units=(\d+)", floor=80,
             units="dry-run / apply / refusal facts checked",
             canaries=("SCOPE reprocess-periods-definition: corpus/saga_10_col_agras analysed",)),
        # ── owner rulings 2026-09-28 (R2, R3): provisions-symmetric and
        # turnover-7411. R2: the 6812 / 6814 charges AND the 7812 / 7814
        # reversals are OUTSIDE EBITDA, their net its own line between EBITDA
        # and the operating result, EBIT unchanged to the cent — five
        # constructed books (both sides, one side each, the analytic / 6-digit
        # code forms, none) through the offline composition, the real write
        # path, GET /api/period and the briefing rebuild; the methodology's
        # reported / strict / operating result and the credit model's rows
        # beside them; five in-file plants. R3: 7411 inside cifra de afaceri
        # netă (F20 rd. 05), 7418 outside, EBITDA unmoved, the margin and
        # FactsGateway on the turnover that holds it — constructed witnesses
        # (no real, corpus or fixture book posts 7411); three plants.
        # Measured 117 / 65. Plant logs: gates.md "provisions-symmetric",
        # "turnover-7411".
        # Deploy-readiness review of feat/rulings-2 (2026-09-29): the pack is
        # verified at BOOT (boot_verify.verify_pl_definition_pack) — missing,
        # not YAML, not UTF-8, wrong schema, crossed classes each fail verify_config.
        Gate("provisions-symmetric",
             [PY, "-m", "pytest", "tests/engine/test_provisions_symmetric.py",
              "tests/engine/test_boot_verify_pl_definition.py", "-q", "-s"],
             work_rx=r"GATE-WORK provisions-symmetric units=(\d+)", floor=100,
             units="constructed books judged, served seams compared, plants",
             canaries=("SCOPE provisions-symmetric (owner ruling R2 2026-09-28, packs/ro/pl_definition.yaml)",
                       "BOOT-VERIFY pl_definition: committed, crossed-classes, missing, not-utf8, not-yaml, wrong-schema",
                       "PROVISIONS-BOOKS: no_provisions, prov_both, prov_charges_only, prov_code_forms, "
                       "prov_reversals_only",
                       "PROVISIONS-PLANTS: reversals-back-inside-ebitda, charges-back-inside-da, "
                       "ebit-forgets-net-provisions, methodology-subtracts-reversals, rebuild-loses-the-ruling")),
        Gate("turnover-7411",
             [PY, "-m", "pytest", "tests/engine/test_turnover_7411.py", "-q", "-s"],
             work_rx=r"GATE-WORK turnover-7411 units=(\d+)", floor=55,
             units="constructed witnesses judged, served seams compared, plants",
             canaries=("SCOPE turnover-7411 (owner ruling R3 2026-09-28, F20 rd. 05, packs/ro/pl_definition.yaml)",
                       "TURNOVER7411-BOOKS: only_7418, subsidy_7411, subsidy_7411_analytic",
                       "TURNOVER7411-PLANTS: 7411-left-in-other-income, 7418-pulled-into-turnover, "
                       "rebuild-drops-the-placement")),
        # ── owner ruling R1 (2026-09-28): credit-stock-build. On a book whose
        # MEASURED net 711 build reaches the pack's shares of net turnover and
        # of total operating expense (packs/credit/model.yaml
        # stock_build_regime), leverage / coverage / DSCR are graded on the
        # served cash from operations (approximated or refused -> refused,
        # never 0, never EBITDA; measured <= 0 -> the declared bottom rung),
        # Altman X3 on EBIT − net 711 − net 72x, the composite on the
        # regime's weights, and the finding (the owner's sentence, RO
        # verbatim + EN, high, the served figures) rides the served block,
        # the attention document and the briefing facts — ONLY where the
        # served figures say what it states (EBITDA > 0, EBITDA before the
        # build <= 0, no measured CFO > 0; fixer round 1), else withheld by
        # name and never handed to the narrator. 14 constructed books, the 4
        # corpus books through GET /api/period, 3 seams, the pack plant
        # (thresholds and weights move with it), 11 in-file plants.
        # Measured 164. Plant log: gates.md "credit-stock-build".
        Gate("credit-stock-build",
             [PY, "-m", "pytest", "tests/engine/test_credit_stock_build_regime.py", "-q", "-s"],
             work_rx=r"GATE-WORK credit-stock-build units=(\d+)", floor=150,
             units="constructed and real books judged, seams compared, plants",
             canaries=("SCOPE credit-stock-build (owner ruling R1 2026-09-28, packs/credit/model.yaml "
                       "stock_build_regime)",
                       "STOCK-BUILD-BOOKS: agras, at_turnover_threshold, below_opex_threshold, "
                       "below_turnover_threshold, carniprod, manufacturer, realestate, refused_711, retail, "
                       "stock_build_approximated, stock_build_cash_negative, stock_build_cash_positive, "
                       "stock_build_cash_refused, stock_build_debt_free, stock_build_negative_ebitda, "
                       "stock_build_negative_ebitda_cash_negative, stock_build_profitable_before_build, "
                       "zero_turnover",
                       "STOCK-BUILD-PLANTS: approximated-cash-read-as-measured, cash-components-on-ebit, "
                       "finding-before-build-unchecked, finding-on-measured-positive-cash, finding-paraphrased, "
                       "finding-sign-unchecked, model-weights-under-the-regime, refusal-falls-back-to-ebitda, "
                       "trigger-threshold-in-code, withheld-names-nothing, x3-keeps-the-stock-build")),
        # ── owner ruling R5 (2026-09-28): supabase-read-retry. The engine's
        # Supabase client logs a WARNING and retries ONCE on a read timeout
        # for its one GET (select), and never retries a write: through the
        # REAL SupabaseClient over a stubbed transport — a read that times out
        # once answers on the second GET with one WARNING line (the table and
        # the parameter NAMES, never a value or the key); twice raises after
        # exactly two; every write method (insert, upsert, update, delete,
        # rpc, signed_url, upload_object, delete_object) that times out raises
        # after ONE request; a connect timeout / connect error / HTTP 500 on a
        # read is not retried; the AST census holds the client's one raw GET
        # inside the retrying helper and no write reaching it. Measured 16.
        # Plant log: gates.md "supabase-read-retry".
        Gate("supabase-read-retry",
             [PY, "-m", "pytest", "tests/engine/test_supabase_read_retry.py", "-q", "-s"],
             work_junit=True, floor=16, units="tests",
             canaries=("test_a_read_that_times_out_once_is_retried_once_and_logged",
                       "test_a_read_that_times_out_twice_raises_after_exactly_one_retry",
                       "test_a_write_that_times_out_is_never_retried",
                       "test_a_read_failing_otherwise_is_not_retried",
                       "test_the_clients_one_get_is_the_retrying_helper_and_no_write_reaches_it",
                       # a junit gate's canaries are its test names (the
                       # battery reads the junit report, not stdout)
                       "test_a_write_that_times_out_is_never_retried[insert]",
                       "test_a_write_that_times_out_is_never_retried[rpc]")),
        # ── plan/2 B4b (plan_contract_v2 5.6 / 28.3 B4): forecast-pools ──
        # The cost pools of section 5 on the four books, no shocks: pools
        # plus unallocated equal the assembled operating cost to the cent;
        # the aggregate fixed share is the one forecast_drivers publishes
        # (contract 4); the cap checked directly (realestate must cap);
        # revenue -20% at inflation 0 moves cost of sales in full and each
        # pool by its variable part (5.3); nil pools by count and on a
        # test-built agras. B5 adds the shock half (scenario-cost-behaviour).
        Gate("forecast-pools",
             [PY, "-m", "pytest", "tests/engine/test_forecast_pools.py", "-q"],
             # floor 50 -> 85 (plan/2 B4 repair): + inflation on the fixed
             # part, held other operating income with the EBITDA identity,
             # the net-credit pool and the max-unallocated refusal (87 measured)
             work_rx=r"GATE-WORK forecast-pools units=(\d+)", floor=85,
             units="pool checks (sums, shares, caps, growth, inflation, held income, nil, negative, refusal)",
             canaries=("SCOPE forecast-pools (plan/2 B4b, contract 5.6)",
                       "capped pools per book",
                       "nil pools per book")),
        # ── end plan/2 B4b ───────────────────────────────────────────────
        # ── plan/2 B5 (plan_contract_v2 28.3 B5): project_plan, the partial
        # refusal, the unwind, debt timing, the one period reader ─────────
        # Seven first registrations. Each test prints its own SCOPE line and a
        # GATE-WORK line; floors are the counts measured at registration,
        # rounded down. forecast-get-b4-parity is retired by B6 (fp1.2).
        Gate("forecast-balance",
             [PY, "-m", "pytest", "tests/engine/test_forecast_levers_f1.py",
              # the request refusals of 2.3-2.6: a malformed lever must
              # refuse, never project (33 cases; counted by the canary below)
              "tests/engine/test_plan_request_validation.py", "-q", "-s", "-rA"],
             work_rx=r"GATE-WORK forecast-balance units=(\d+)", floor=7000,
             units="projected periods re-added by the test (base and plan runs)",
             canaries=("SCOPE forecast-balance (plan/2 B5, gate row F1)",
                       "run kinds covered: base, plan",
                       "test_the_wire_body_and_the_dataclass_give_the_same_plan")),
        Gate("scenario-funding-line",
             [PY, "-m", "pytest", "tests/engine/test_scenario_funding_line.py", "-q", "-s"],
             work_rx=r"GATE-WORK scenario-funding-line units=(\d+)", floor=1500,
             units="period identities (floor, draw, revolver, interest) plus runway cases",
             canaries=("SCOPE scenario-funding-line (plan/2 B5, contract 6.4-6.6, S3 engine half)",
                       "ShortfallRefusal cells (6.5)",
                       "runway annual tail: bracket")),
        Gate("scenario-cost-behaviour",
             [PY, "-m", "pytest", "tests/engine/test_scenario_cost_behaviour.py", "-q", "-s"],
             work_rx=r"GATE-WORK scenario-cost-behaviour units=(\d+)", floor=110,
             units="cost-of-sales checks under shocks, pool levels, the EBITDA law, refused-split refusals",
             canaries=("SCOPE scenario-cost-behaviour (plan/2 B5, contract 5.6)",
                       "law precondition met on")),
        Gate("forecast-magnitude",
             [PY, "-m", "pytest", "tests/engine/test_forecast_magnitude_f6.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-magnitude units=(\d+)", floor=20,
             units="year-one revenue checks with the band rendered from the run",
             canaries=("SCOPE forecast-magnitude (plan/2 B5, gate row F6 engine half)",
                       "bands rendered from the run")),
        Gate("period-loader-parity",
             [PY, "-m", "pytest", "tests/engine/test_load_period_rows.py", "-q", "-s"],
             work_rx=r"GATE-WORK period-loader-parity units=(\d+)", floor=20,
             units="statement keys compared byte for byte, plus the refusal paths",
             canaries=("SCOPE period-loader-parity (plan/2 B5, contract 1.4)",)),
        # forecast-get-b4-parity was registered here by B5 and is RETIRED by
        # plan/2 B6 (contract 28.3): fp1.2 replaced the fp1 bytes it pinned.
        # GET equals POST (scenario-one-engine) and the served-bytes gates
        # take over; its plant log stays in gates.md, its plan_gates.json
        # entry carries retired_in B6.
        Gate("forecast-debt-timing",
             [PY, "-m", "pytest", "tests/engine/test_forecast_debt_timing.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-debt-timing units=(\d+)", floor=30,
             units="debt movements checked for their period, plus the horizon refusal",
             canaries=("SCOPE forecast-debt-timing (plan/2 B5, contract 6.7)",)),
        # ── end plan/2 B5 ────────────────────────────────────────────────
        # ── plan/2 B1 (plan_contract_v2 28.3, section 7, S7): sign-flip ──
        # One sign-flip classifier per runtime (engine.serving.change_kind,
        # frontend/lib/changeKind.ts) held to one truth table; comparatives
        # columns carry change_kind and no cross-sign percentage. Work is
        # the SUM of the GATE-WORK lines the tests print (truth-table rows,
        # converted consumers, comparative columns swept). Floor 300 = the
        # measured 339 (70 + 14 + 255), rounded down. The rendered half is
        # the vitest canaries changeKind.test.ts and signFlip.test.tsx.
        Gate("sign-flip",
             [PY, "-m", "pytest", "tests/engine/test_change_kind.py",
              "tests/engine/test_comparatives.py", "-v", "-s"],
             work_rx=r"GATE-WORK sign-flip units=(\d+)", work_sum=True,
             floor=300, units="truth-table rows + consumers + columns",
             canaries=("test_the_python_classifier_matches_every_truth_table_row",
                       "test_a_cross_sign_column_carries_its_kind_and_no_percentage",
                       "SIGN-FLIP truth table (python)")),
        # ── end plan/2 B1 ────────────────────────────────────────────────
        # ── plan/2 B6 (plan_contract_v2 28.3 B6): fp1.2 serving and POST
        # /api/forecast/{period_id}/recompute ────────────────────────────
        # Eight first registrations, each through the REAL create_app. Every
        # test prints its own SCOPE and GATE-WORK line; floors are the counts
        # measured at registration, rounded down. forecast-cache runs on the
        # tenancy double (membership walls); the others on the committed-book
        # row server (as-built B0-6). forecast-route, forecast-serving-
        # boundary and the cross-org sweep were extended in place.
        Gate("forecast-server-side",
             [PY, "-m", "pytest", "tests/engine/test_forecast_recompute_f2.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-server-side units=(\d+)", floor=4000,
             units="served numbers re-walked from the served figures",
             canaries=("SCOPE forecast-server-side (plan/2 B6, gate row F2)",)),
        Gate("forecast-provenance",
             [PY, "-m", "pytest", "tests/engine/test_forecast_provenance_f4.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-provenance units=(\d+)", floor=8000,
             units="drivers, figures and series points resolved",
             canaries=("SCOPE forecast-provenance (plan/2 B6, gate row F4)",)),
        Gate("forecast-byte-stability",
             [PY, "-m", "pytest", "tests/engine/test_forecast_byte_stability_f8.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-byte-stability units=(\d+)", floor=16,
             units="body hashes compared in process and against a second process",
             canaries=("SCOPE forecast-byte-stability (plan/2 B6, gate row F8)",
                       "PYTHONHASHSEED=12345")),
        Gate("forecast-latency",
             [PY, "-m", "pytest", "tests/engine/test_forecast_recompute_f9.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-latency units=(\d+)", floor=80,
             units="timed chart-profile POSTs (N=20 per book)",
             canaries=("SCOPE forecast-latency (plan/2 B6, gate row F9, in process)",
                       "bytes (cap")),
        Gate("forecast-lever-reach",
             [PY, "-m", "pytest", "tests/engine/test_forecast_lever_reach.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-lever-reach units=(\d+)", floor=350,
             units="nudges sent through POST recompute (driver x allowed op x book)",
             canaries=("SCOPE forecast-lever-reach (plan/2 B6, contract 12)",
                       "levers declared 38",
                       # B6 repair: the cross-book liveness check ran
                       "cross-book: ")),
        Gate("scenario-one-engine",
             [PY, "-m", "pytest", "tests/engine/test_scenario_one_engine.py", "-q", "-s"],
             # forecast-scenarios-live (R6): + GET == scenario(base) block by
             # block, and the /scenario + template routes in the handler walk
             work_rx=r"GATE-WORK scenario-one-engine units=(\d+)", floor=18,
             units="GET-equals-POST and GET-equals-scenario(base) cells plus the handler walk",
             canaries=("SCOPE scenario-one-engine (plan/2 B6 + R6, gate row S4",
                       "GET == scenario(base) (every block)")),
        Gate("scenario-provenance",
             [PY, "-m", "pytest", "tests/engine/test_scenario_provenance.py", "-q", "-s"],
             work_rx=r"GATE-WORK scenario-provenance units=(\d+)", floor=8000,
             units="figures and series points whose lever ids were re-derived by "
                   "removal POSTs, LEVERED and WINDOWED (measured 8408)",
             canaries=("SCOPE scenario-provenance (plan/2 B6, gate row S6)",
                       # B6 repair: the windowed request ran on every book
                       "realestate/windowed: figures and series points checked")),
        Gate("forecast-cache",
             [PY, "-m", "pytest", "tests/engine/test_forecast_cache.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-cache units=(\d+)", floor=8,
             units="POSTs (owner base/shocked/base, strangers) plus cache entries read",
             canaries=("SCOPE forecast-cache (plan/2 B6, contract 1.5)",)),
        # ── end plan/2 B6 ────────────────────────────────────────────────
        # ── plan/2 B13 (minimal cut, 2026-09-21): the Scenarios page on the
        # engine. What the ENGINE does with the page's own template file
        # (frontend/lib/scenarioTemplates.json) on the four corpus books; the
        # vitest canary scenariosEngine.test.tsx pins what the page SENDS.
        # Deliberately NOT a plan_gates.json entry: the full B13 (the
        # scenario-closure gate, the playwright run) has not landed, and an
        # entry landed_in B13 would mark the batch landed. Floor = the
        # measured 515 units, rounded down.
        Gate("scenario-page-templates",
             [PY, "-m", "pytest", "tests/engine/test_scenario_page_templates.py", "-q", "-s"],
             # forecast-scenarios-live: the templates are pack data the ENGINE
             # compiles (packs/scenarios/templates.yaml, FMCG Romania); measured 729
             work_rx=r"GATE-WORK scenario-page-templates units=(\d+)", floor=700,
             units="templates projected or refused by name, plus per-period cash and balance checks",
             canaries=("SCOPE scenario-page-templates (packs/scenarios/templates.yaml",
                       "refused by name: ")),
        # ── end plan/2 B13 ───────────────────────────────────────────────
        # ── forecast-scenarios-live: the owner's gates F1-F5 (engine half),
        # the sector rung of revenue_growth, and the registry flag. F6 (and
        # the page half of F1 / F5) is the forecast-f-page gate below. Plant
        # logs: gates.md "forecast-f-gates", "forecast-sector-rung",
        # "forecast-scenarios-active", "forecast-f-page".
        Gate("forecast-f-gates",
             [PY, "-m", "pytest", "tests/engine/test_forecast_f_gates.py", "-q", "-s"],
             # measured on the four committed corpus books without the opt-in
             # local Scandia pair (FORECAST_LOCAL_SCANDIA adds it)
             work_rx=r"GATE-WORK forecast-f-gates units=(\d+)", floor=20000,
             units="year-zero figures, balance/cash ties, byte comparisons, moved-line checks and debt periods",
             canaries=("SCOPE forecast-f1..f5 (forecast-scenarios-live)",
                       "F1 books: agras, carniprod, retail, realestate")),
        Gate("forecast-sector-rung",
             [PY, "-m", "pytest", "tests/engine/test_forecast_sector_rung.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-sector-rung units=(\d+)", floor=30,
             units="sector evidence fields, ladder steps and pins checked",
             canaries=("SCOPE forecast-sector-rung",
                       "sector rung: agras CAEN 1011")),
        # forecast-scenarios-live rollout (2026-09-26): both rows are `active`
        # for everyone, each advertising the route its page reads, once the
        # cockpit's F1 and F2 passed on the Scandia pair and agras. Replaces
        # "scenarios-preview" (both rows coming_soon). Plant log: gates.md
        # "forecast-scenarios-active".
        Gate("forecast-scenarios-active",
             [PY, "-m", "pytest", "tests/engine/test_forecast_scenarios_active.py", "-q"],
             work_junit=True, floor=6, units="tests",
             canaries=("test_forecast_and_scenarios_are_active_in_the_source_with_their_endpoints",
                       "test_the_advertised_endpoints_are_routes_the_real_app_mounts",
                       "test_served_active_for_everyone_and_the_env_promotes_only_what_it_names")),
        # The PAGE half of F1 / F5 / F6 and the preview opt-in: what the
        # Forecast and Scenarios pages paint and save, rendered over the real
        # served bytes (vitest). Named on its own, like ratio-byte-match,
        # because each defect it covers paints a believable page: a year 0
        # that is a second opinion about the actuals, "RON 0" where the
        # engine served cents, another company's saved scenario, an English
        # engine sentence on a Romanian page. Measured 57 tests, floor 50.
        # Plant log: gates.md "forecast-f-page".
        Gate("forecast-f-page",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/forecast/__tests__/forecastYearZero.test.tsx",
              "frontend/pages/cfo/__tests__/forecastCompanyAndPlaceholders.test.tsx",
              "frontend/pages/cfo/__tests__/scenariosSaved.test.tsx",
              "frontend/pages/cfo/__tests__/scenariosEngine.test.tsx",
              "frontend/lib/__tests__/featuresPreview.test.ts",
              "frontend/lib/__tests__/forecastSentencesRo.test.ts",
              "frontend/components/forecast/__tests__/forecastNetProvisionsStep.test.tsx",
              "--reporter=verbose"],
             # + forecastSentencesRo (RO + EN): every sentence of the engine's
             # served inventory comes out in Romanian under the digit law and
             # in English byte for byte; + the preview opt-in's first-paint
             # cache (featuresPreview); + the refused DIO driver in its
             # own words, the Romanian mirror held to the pack
             # (feat/inventory-days, 2026-09-28). Measured 73, floor 60.
             # + the review round of release r-rulings2 (2026-10-01, ruling
             # R2): the step the plan does not project — net provisions — on
             # the Forecast appendix (row + sentence, EN and RO), the
             # not-modelled list and the Scenarios lever rail in the reader's
             # language, over the engine's captured bytes. Measured 77.
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=60,
             units="page tests (F1 year 0, F5 placeholders, F6 saved scenarios, preview opt-in, served-sentence language)",
             canaries=("gate F1: year 0 is the dashboard's headline",
                       "gate F5 on the Forecast statements",
                       "gate F5: no dash and no zero where the engine served a figure",
                       "gate F6: a saved scenario survives reload and belongs to its company",
                       "comes out in Romanian, digits exactly the served ones, no English left",
                       "the Scenarios lever rail's unserved sentence: Romanian by its served code, English as served")),
        # The engine half of RO + EN: the committed inventory of every
        # sentence the two pages paint (tests/engine/fixtures/forecast/
        # served_sentences.json) IS what the real route serves on the corpus
        # books, so an engine that rewords a sentence reds here before a
        # Romanian page prints it in English. Measured 164 sentences.
        # Plant log: gates.md "forecast-served-sentences".
        Gate("forecast-served-sentences",
             [PY, "-m", "pytest", "tests/engine/test_forecast_served_sentences.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-served-sentences units=(\d+)", floor=150,
             units="distinct served sentences the Forecast and Scenarios pages paint",
             canaries=("SCOPE forecast-served-sentences",
                       "worlds agras, agras_caen1011, agras_caen1011_paired")),
        # THE FORECAST COCKPIT (owner spec 2026-09-21): the page does NO math.
        # Over a SYNTHETIC double of POST /api/forecast/{id}/cockpit: the four
        # numbers, chart, bridge and statements are the engine's (◇ on every
        # projected figure), debounce + latest-response-wins, reset -> the
        # case's bytes (F4), saved cases per company (F6), present mode,
        # the bank export from the engine's export data, no 100× (FC1/FC2),
        # and the no-math source scan (R1-R6), plus the lever-scale gate
        # (2026-09-26: a slider's scale is the lever's served `decimals`, a
        # position the wire decimal — replayed over the synthetic book and
        # the agras bytes captured from the real route). Measured 75 tests,
        # floor 60. Plant log: gates.md "forecast-cockpit-page".
        Gate("forecast-cockpit-page",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/pages/cfo/__tests__/forecastCockpit.test.tsx",
              "frontend/pages/cfo/__tests__/forecastCockpitLeverScale.test.tsx",
              "frontend/pages/cfo/__tests__/forecastMagnitude.test.tsx",
              "frontend/components/forecast/cockpit/__tests__/cockpitNoMoneyMath.test.ts",
              "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=60,
             units="cockpit page tests (engine-served figures, latest-wins, F4, F6, no 100x, no-math scan, lever scale)",
             canaries=("LATEST RESPONSE WINS: an older answer arriving last never overwrites the newer one",
                       "gate F4: reset lands on the case answer EXACTLY, from the served bytes",
                       "GATE-WORK forecast-cockpit-lever-scale engines=",
                       "saves the WHOLE lever set to the company on screen",
                       "no statement cell renders at a different magnitude from the bytes behind it",
                       "R5: the GATEWAY opens the opaque amount in exactly two places and divides once")),
        # The cockpit gateway's static half: lib/forecastCockpit.ts declares the
        # opaque CockpitMinor, formats nothing, opens it in exactly two doors,
        # and only the primitive / chart / bank export name those doors. Same
        # script as forecast-boundary, its own count. Measured 4 files.
        # Plant log: gates.md "forecast-boundary-cockpit".
        Gate("forecast-boundary-cockpit", ["node", "scripts/check_forecast_boundary.mjs"],
             work_rx=r"GATE-WORK forecast-boundary-cockpit units=(\d+)", floor=3,
             units="files naming a door of the cockpit gateway",
             canaries=("GATE-WORK forecast-boundary-cockpit",)),
        # The forecast COCKPIT (forecast-scenarios-live, owner-approved spec):
        # four numbers, one chart, sliders, computed by the engine through
        # POST /api/forecast/{id}/cockpit — the page does no math. F1-F9 as
        # they apply to the cockpit (year 0 = the dashboard, every case and
        # every slider extreme balances, same bytes twice and across hash
        # seeds, the base case IS the forecast and a lever moves only its
        # lines by what its basis states, no placeholder and interest on debt
        # and on a drawn line, saved cases per company, growth from the
        # book's own history, a priced credit line below the floor, a bridge
        # from base that sums exactly), the routes and the export, and p95
        # slider latency inside the pack's budget. Measured 12242 on the four
        # corpus books (FORECAST_LOCAL_SCANDIA adds the owner's pair). Plant
        # log: gates.md "forecast-cockpit".
        Gate("forecast-cockpit",
             [PY, "-m", "pytest", "tests/engine/test_forecast_cockpit.py", "-q", "-s"],
             work_rx=r"GATE-WORK forecast-cockpit units=(\d+)", floor=11000,
             units="year-zero figures, balance/cash ties, byte comparisons, moved-line and "
                   "magnitude checks, figures walked, bridge steps and timed slider moves",
             # + the one-engine cell (2026-09-26): the Scenarios route, sent
             # the very overrides the cockpit compiled a case or a slider set
             # to, serves every statement figure the cockpit serves, to the
             # cent — the two pages are one engine. Measured 550 figures per
             # corpus book (14442 units on the four books).
             canaries=("SCOPE forecast-cockpit (forecast-scenarios-live)",
                       "C-F1 books: agras, carniprod, retail, realestate",
                       "C-F10 agras: 13 levers, scale held across 4 moved answers",
                       "C-ONE-ENGINE agras: 550 figures agree between the cockpit and the scenario route",
                       # review round 2026-10-01 (ruling R2): the year-0-only
                       # net-provisions row on the books that carry them
                       "C-NP books carrying net provisions: agras, carniprod, retail")),
        # MARGIN-MEANING (2026-09-26): ONE rule for when a margin over turnover
        # is not meaningful — turnover negligible against operating activity
        # (packs/ratios/margin_meaning.yaml, engine.ratios.margin_meaning) —
        # asked by the ratio table, GET /api/period and the forecast cockpit.
        # Held over every corpus book the real write path and the real route
        # serve (17): each served body with the rule IS the body with the rule
        # neutralised, except the developer, where exactly the five margin rows
        # move; the developer shows the refusal and the one note everywhere
        # (period, ratio rows, cockpit numbers, sentence, bank export), RO and
        # EN; four in-file plants red the same checkers. Measured 187 units.
        # Plant log: gates.md "margin-meaning".
        Gate("margin-meaning",
             [PY, "-m", "pytest", "tests/engine/test_margin_meaning.py", "-q", "-s"],
             work_rx=r"GATE-WORK margin-meaning units=(\d+)", floor=150,
             units="rule boundaries, pack refusals, served books compared, developer surfaces and plants",
             canaries=("SCOPE margin-meaning (packs/ratios/margin_meaning.yaml)",
                       "MM-DEVELOPER saga_10_col_realestate refused on 5 ratio rows",
                       "MM-PLANTS: threshold-reaches-a-normal-book, threshold-under-the-developer, "
                       "table-ignores-the-verdict, cockpit-ignores-the-verdict")),
        # The pages' half: every surface that prints a margin — the P&L key
        # margins, the KPI card, the ratio bundle behind the Ratios tab, the
        # drawer, the printed report and the workbook, the EBITDA
        # reconciliation, the served ratio rows, the cockpit's four numbers and
        # the bank export — prints the ENGINE's refusal (RO and EN) on the
        # developer, the note only there, the same bytes on every other book,
        # and no percent of a thousand or more in the developer's documents.
        # Measured 18 tests. Plant log: gates.md "margin-meaning-page".
        Gate("margin-meaning-page",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/marginMeaning.test.tsx", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=15,
             units="page tests (every surface that prints a margin, RO and EN, the note, the acceptance rule)",
             canaries=("THE ACCEPTANCE RULE: no percent of a thousand or more anywhere in the developer's document",
                       "the bank export prints the refusal and the note, and no percent of a thousand or more")),
        # ── owner ruling 2026-09-26, design A7 (stage F1): pl-one-ebitda-page ──
        # The P&L tab prints THE ONE EBITDA the engine serves: both builders
        # read every subtotal off the served block (refused = the typed
        # reason, never 0 or a derivation), "Variația stocurilor de produse"
        # (711) sits beside the cost block, signed, with the engine's
        # provenance and the owner's name verbatim (English gloss in the
        # English UI), 72x is its own row outside net turnover, the 121
        # remainder is never folded into 711, the served reconciliation line
        # stands under EBITDA, the EbitdaReconciliationPanel prints the served
        # chain, and the retired "clean EBITDA" footnote / +722 bridge stay
        # retired. Over the four firm books and six CONSTRUCTED books of
        # net-711-rule captured through the real route (held live by
        # tests/engine/test_one_ebitda_fe_books.py). Measured 58 tests, floor
        # 50. Plant log: gates.md "pl-one-ebitda-page".
        # Deploy-readiness review of feat/rulings-2 (2026-09-29, owner ruling
        # R2): the net-provisions row prints current, prior and Δ on ONE sign
        # convention (charge-signed, as D&A) — the committed pair and its
        # constructed mirror. Measured 63 -> 66.
        # Pre-deploy review of release/r-rulings2 (2026-10-01): the
        # reconciliation line under EBITDA prints net provisions on the row's
        # convention (the row's served figure, no effect sign), EN and RO,
        # on the pair and its mirror. Measured 66 -> 68, floor 60 -> 66.
        # Its review round (2026-10-01): the Valuation tab's panel (/report
        # Section 1 too) prints the bridge after EBITDA as the P&L tab does
        # (the served charge), and the panel's chain row and the printed P&L
        # (report + workbook) state the EFFECT's arithmetic beside the effect
        # they print — the label evaluates to the figure. Measured 68 -> 72,
        # floor 66 -> 72.
        # Review round 3 (coordinator ruling D2, 2026-10-02): ONE CONVENTION
        # PER ROW, EVERYWHERE — on every surface that prints the row (the
        # P&L tab and its compare cells, the Valuation tab's panel, /report
        # §1 and §2, the printed report and the workbook read back from the
        # documents) ANY account arithmetic in the row's FULL TEXT evaluates
        # to the figure it prints (frontend/test/netProvisionsArithmetic.ts;
        # the earlier law read one named chip and missed /report §2's charge
        # label over the effect and the panel row stating both
        # arithmetics); the P&L tab's served chips ("fără" / "excl.") and
        # the compare cells' percent, share and points print in the
        # reader's language. Measured 72 -> 100, floor 72 -> 100.
        Gate("pl-one-ebitda-page",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/plOneEbitda.test.tsx",
              "frontend/lib/__tests__/netProvisionsRowSign.test.tsx",
              "frontend/lib/__tests__/netProvisionsEverySurface.test.tsx",
              "frontend/pages/cfo/__tests__/comprehensiveReportNetProvisions.test.tsx", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=100,
             units="P&L-tab tests (served subtotals, the 711 row, refusals RO/EN, 72x, the 121 remainder, the reconciliation line, the panel, retired copy, the net-provisions row's sign on the row, the line, the panel and the printed P&L)",
             canaries=("covers eleven books, three of them refused",
                       "unanchored: every refused figure states the engine's reason, RO and EN",
                       "closed_no_activity: no stock-variation row, the remainder labelled, then account 121",
                       "renders the owner's name verbatim in Romanian, and with the engine's gloss in English",
                       "the served pair (current a net charge, prior a net release): the row prints current, prior and Δ charge-signed, as D&A prints its own",
                       "the served pair (current a net charge, prior a net release): the reconciliation line above the row prints net provisions on the row's convention, EN and RO",
                       "the served pair (current a net charge): the panel's bridge after EBITDA prints the P&L tab's figure, and its chain row's arithmetic is its figure, EN and RO",
                       "the served pair (current a net charge): the printed P&L (report + workbook) — the row's arithmetic is its figure, the bridge after EBITDA the P&L tab's charge",
                       "agras (en): the Valuation tab's panel — the chain row states ONE arithmetic, its figure's",
                       "carniprod: the printed report and the workbook — the row read back from each document",
                       "agras (ro): §2's row and §1's chain row each print the figure their own text states",
                       "agras: \"fără\" for a Romanian reader, \"excl.\" for an English one — D&A and other operating income",
                       "the rendered rows: the net-provisions row's share cell and D&A's Δ% cell, RO and EN")),
        # ── owner ruling 2026-09-26, design A8 (stage F2): the three surface
        # gates. Every other frontend surface — deriveTotals, computeRatios,
        # canonicalMetrics, the dashboard headline / canon / configurable
        # tiles, the learning snapshot, the recommendation facts, the printed
        # report and the workbook (P&L sheet + cover), multi-year growth, the
        # EBITDA bridge chart, the NAV cascade and the no-envelope credit
        # model — prints THE ONE EBITDA the engine serves (one-ebitda), divides
        # every margin and growth figure by net turnover (turnover-
        # denominator), and carries a refused EBITDA as the engine's refusal
        # (refusal-carries). Over the four firm books and the six CONSTRUCTED
        # books of net-711-rule captured through the real route. Measured 25 /
        # 8 / 10 tests. Plant log: gates.md "one-ebitda", "turnover-
        # denominator", "refusal-carries".
        # Deploy-readiness review of feat/rulings-2 (2026-09-29, owner ruling
        # R2): the non-cash add-back is the cash flow's (all of 68x), never
        # the narrowed P&L D&A — the client DCF (Valuation tab, workbook
        # Valuation sheet) and the Cash Flow tab take it back / add it, and
        # the row holding the 6812 / 6814 charges is named for them on the
        # tab (EN / RO), /report §4 and the workbook. Measured 25 -> 40.
        # Pre-deploy review of release/r-rulings2 (2026-10-01): the Valuation
        # tab's FCF tile carries the same name over the same add-back (EN /
        # RO, from fcf_breakdown and the client fallback); the label widens
        # from the comparison's prior; no D&A-only explainer over the widened
        # row; the second step of the add-back order; /report's printed
        # figure; the alert trace hint. Measured 40 -> 53, floor 36 -> 50.
        # Review round 3 (coordinator rulings D2 / D3, 2026-10-02): Budget
        # Variance's Actual column READS the served EBITDA -> EBIT chain (it
        # computed EBIT as EBITDA less all of 68x, short by the 7812 / 7814
        # reversals since R2 — a hidden page, wrong all the same), with D&A
        # from assembled_pl and a net-provisions row; the CFO and FCF Learn
        # popovers name the all-68x add-back for the provision charges it
        # holds. Measured 53 -> 65, floor 50 -> 65.
        Gate("one-ebitda",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/oneEbitdaSurfaces.test.tsx",
              "frontend/lib/__tests__/provisionsAddBack.test.tsx",
              "frontend/pages/cfo/__tests__/comprehensiveReportAddBack.test.tsx",
              "frontend/lib/comparison/__tests__/varianceServedChain.test.ts",
              "frontend/lib/__tests__/learnAddBackToken.test.ts", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=65,
             units="surface tests (every browser surface prints the served EBITDA on eight served books; the R2 add-back)",
             canaries=("covers eight served books, and on six of them the build-up before 711 / 72x differs from EBITDA",
                       "agras: the printed report, the workbook and the charts",
                       "realestate: Debt / EBITDA and the no-envelope credit model divide the served EBITDA",
                       "three firm books post 6812 / 6814 charges: the cash flow's add-back exceeds the P&L's D&A by exactly them",
                       "carniprod: stabilised FCF = CFO − assembled_cf.depreciation, whatever the P&L's D&A",
                       "retail: the row is named for what it sums — the tab (EN, RO) and the workbook",
                       "carniprod posts 6812 / 6814 charges: the row holding all of 68x names them",
                       "agras: with assembled_cf.depreciation absent, the builder and runDcf take assembled_pl.depreciation",
                       "a book posting no charges compared with one that does: the widened name, from the prior column",
                       "retail: Simple mode's glossary tooltip and the D&A learn popover only over plain D&A",
                       "carniprod: the tile from the engine's fcf_breakdown and from the client fallback, EN and RO",
                       "the depreciation fact's hint: the pack's D&A name, none of the ruled provision accounts",
                       "the witnesses: three books post reversals, so EBITDA − all of 68x is NOT the served operating result",
                       "agras: EBIT, D&A and net provisions are the served figures, and the rows foot",
                       "realestate posts none: the token stays plain D&A, and is the P&L's D&A")),
        # ── design A8 (stage G1): exportRatioFormulas' DISCRIMINATING scope
        # was made vacuous by the 121 bridge — on the four firm books the
        # build-up + the served 711 IS account 121, so a net-income ratio
        # re-pointed at it stayed green. The constructed closed_no_activity
        # (a 2,000.00 misread no line names) is the witness. Measured 15
        # tests. Plant log: gates.md "export-ratio-anchor".
        Gate("export-ratio-anchor",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/exportRatioFormulas.test.ts", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=13,
             units="printed-ratio tests (formulas, values, net income on account 121)",
             canaries=("constructed closed_no_activity: every net-income ratio consumes account 121, "
                       "on a divergence no line names",
                       "at least one book tells the filed account-121 figure from the reconstruction (TC-3)")),
        Gate("turnover-denominator",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/turnoverDenominator.test.tsx", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=6,
             units="surface tests (margins and growth over net turnover, on books where total operating revenue differs)",
             canaries=("four books carry total operating revenue ≠ net turnover (72x or other operating income), so a wrong denominator shows",
                       "bridge_with_722: the first line, the margins, the facts, the report, the workbook and growth")),
        Gate("refusal-carries",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/refusalCarries.test.tsx", "--reporter=verbose"],
             # fixer round 2: floor raised from 12 with Graham, Piotroski, the
             # report's balance sheet and a refused prior cash flow (20).
             # critic fixer round 1 (third round): the unanchored_unbalanced
             # witness, total equity short by the refused result, the refused
             # Piotroski tile's checks and the refusal-only CF statement (30).
             # critic fixer round 2: every other reader of total equity — the
             # report's §1 equity ratio and §6 book equity, canonicalMetrics,
             # the dashboard resolver and cards, periodFacts, the document's
             # recommendation rules, the Capsule fact index and the chat
             # context (38).
             # critic round 3 fixer (2026-09-28): the chat's Headline metrics
             # over stale rows, F1 / F5 witnesses, no NaN on the Valuation tab
             # or in the workbook, no bare dash on the Risks tab / report /
             # export (47).
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=44,
             units="surface tests (a refused EBITDA stays refused, with the engine's reason, on every surface)",
             canaries=("covers the three refused books, and on each the buckets would rebuild a number",
                       "unanchored: growth, the credit model, the DCF and the NAV cascade refuse with it",
                       "a payload the engine did not assemble, whose buckets show 711 activity, refuses the same way",
                       "unanchored: the net result, ROE, ROA, the report and the cash flow refuse with the engine's reason",
                       # fixer round 2 (2026-09-27)
                       "unanchored: the NAV cascade has no Graham figure and no band built on it — the page prints the reason",
                       "unanchored: no Piotroski score or band off nine uncertain checks — served, or a block stored before the engine refused it",
                       "unanchored: the report's balance sheet prints the reason on the current-year row — served, or stored with the build-up",
                       "a comparative cash flow whose PRIOR period is refused prints no prior figure and no delta — the reason instead",
                       # critic fixer round 1 (third round, 2026-09-27)
                       "unanchored_unbalanced: Book NAV, Layers 1-3, the sensitivity grid and the hero refuse — the page prints the reason",
                       "unanchored_unbalanced: the engine Altman reader prints X2 refused, the equity sub-score refuses with the reason",
                       # critic fixer round 2 (2026-09-27)
                       "unanchored_unbalanced: the report's §1 Equity ratio and §6 Book equity print the reason — never 47.6 % or 200,000",
                       "unanchored_unbalanced: periodFacts refuses total equity and every ratio on it — no `mOr` fallback, no stale row",
                       "unanchored_unbalanced: the chat context states the refusal — never 'Total equity 200,000'",
                       "unanchored_unbalanced: the document's recommendation rules grade no exposure against the short equity",
                       "unanchored_unbalanced: the equity ratio and debt / equity refuse with the engine's reason; balanced, they compute",
                       # critic round 3 fixer (2026-09-28)
                       "the chat's 'Headline metrics' over rows persisted before the refusal: the build-up and the short-equity ratios are stated refused, never printed",
                       "the workbook: no NaN or Infinity cell on any sheet of any fixture book; the refused books print the reason",
                       "the Valuation tab: no NaN, no 'Cash burning' beside a refused FCF — the engine's reason on every refused tile",
                       "the Risks tab's Altman table and the report's §7 card print the engine's reason on X2, X3 and X4")),
        # ── fixer round 1 (2026-09-27): valuation-refused-override ────────
        # The Valuation tab seeded a refused EBITDA as 0 and sent it on EVERY
        # save (debt, cash, the multiple slider): the engine applied the 0 as
        # a user override, routed on `ebitda_not_positive` and the page showed
        # an editable "EBITDA RON 0" instead of the refusal. A save now sends
        # only an EBITDA the user typed. Engine half: valuation-one-ebitda's
        # test_an_override_of_debt_or_the_multiple_alone_keeps_the_ebitda_refused.
        # Measured 5 tests; 7 with a refused book equity and a withheld
        # stored row printing their reason (critic fixer round 1).
        # Plant log: gates.md "valuation-refused-override".
        # ── owner ruling R1 (2026-09-28): credit-regime-surfaces. Every
        # surface that prints the grade prints the stock-build regime ONCE —
        # the Risks tab, the dashboard hero (which states the engine's
        # refusal, never "analysis pending"), /report's CreditScoreCard and
        # the command bar's rest-state line — with the owner's sentence
        # verbatim (RO + EN), the cash bases on the three cash components and
        # the regime's served weights; nothing on a standard book. Over the
        # route's own bytes (served_credit_regime.json, kept by
        # test_credit_regime_fe_fixture.py); the exported HTML report and
        # the workbook state it too. A WITHHELD finding (fixer round 1: the
        # served figures contradict the sentence) prints the regime once and
        # the sentence nowhere, the command bar keeping the label, the cash in
        # the served currency. Measured 14 tests, floor 14.
        # release r-rulings2 (2026-10-01, the merge with the reader's-language
        # ruling, CLAUDE.md §26): every regime figure in the SURFACE's
        # language — the note bound to its own `lang`, the exported report and
        # workbook English whatever the UI language, the bar's line through a
        # printer bound to the bar's language; expected strings stated, the
        # rendered note read by the independent detector
        # (frontend/test/numberLanguage.ts). Measured 19 tests, floor 19.
        # Review round (2026-10-01): the Ask CFO AI workspace snapshot is a
        # regime surface too — the served label, the owner's finding EN + RO
        # (none where withheld), the cash refusal, the composite / letter or
        # their refusal through `engineCreditResult`, and the engine's margin
        # refusal on the margin rows (chatSnapshotCreditRegime). Measured 24,
        # floor 24.
        # Review round 4 (2026-10-02): a letter the engine REFUSED is refused
        # in the engine's words in the exported report too (never the
        # extraction note, the "no band ladder" sentence or "points of the
        # composite were given up"), and Altman X3 is labelled with the basis
        # it was computed on — on the Risks tab, /report's card and the
        # printed formula the X3 row's stated arithmetic evaluates to the
        # figure beside it. Measured 33, floor 33.
        # Plant log: gates.md "credit-regime-surfaces".
        Gate("credit-regime-surfaces",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/pages/cfo/__tests__/creditRegimeSurfaces.test.tsx",
              "frontend/pages/cfo/__tests__/chatSnapshotCreditRegime.test.ts", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=33,
             units="surface tests (the regime once, the owner's sentence, the cash bases, the reader's language, the chat snapshot)",
             canaries=("developer (EN): one regime block, the finding, the refused composite, the cash bases",
                       # review round 4 (2026-10-02): the refused letter's
                       # words, and the X3 basis
                       "the developer's document: no extraction note, no 'no ladder', no 'points given up' — the served refusal instead",
                       "the exported report: the Altman formula's X3 term evaluates to the Z″ printed beside it, and the regime sentence states the basis",
                       "the Risks tab's Altman table (ro): the X3 row's stated arithmetic is the X3 it prints",
                       "the hero states the refusal, not 'analysis pending', and the regime once",
                       "/report's credit card prints the regime once, and none for a manufacturer",
                       "CmdbarList renders it once at rest and not while typing",
                       "the documents and the command bar: the regime's label, no sentence",
                       # release r-rulings2: the reader's language
                       "bound to a language, the amount prints that language whatever the UI language — the code after the figure",
                       "GATE-WORK credit-regime-ui-language en figures=",
                       "GATE-WORK credit-regime-ui-language ro figures=",
                       "the documents are English by contract: under a Romanian UI the regime sentence still prints English figures",
                       # review round 2026-10-01: the chat snapshot
                       "the developer: the regime EN + RO, the owner's finding verbatim, the cash refusal, the composite REFUSED",
                       "the withheld finding: the regime once, the owner's sentence in neither language")),
        Gate("valuation-refused-override",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/cfo/__tests__/valuationRefusedOverride.test.tsx", "--reporter=verbose"],
             # critic round 3 fixer (2026-09-28): a withheld stored row on its
             # own cause, no 0.0x slider or multiple save when none is served (10).
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=9,
             units="interaction tests (a valuation save sends only an EBITDA the user typed)",
             canaries=("editing Total debt sends no EBITDA",
                       "moving the multiple slider sends no EBITDA",
                       "editing Cash does not pin the served EBITDA as a user assumption",
                       "no peer multiple served: no 0.0× slider and no editor whose save would pin a multiple of 0")),
        # RATIOS: the engine as the one authority for ratio values, bands,
        # deltas, band movements and credit composites (critic
        # authority_decision). Four gates, one per batch, named separately
        # from `pytest` because each defect they cover prints a believable
        # number rather than crashing: a credit weight moved with no
        # revision, an engine ratio one digit off the printed FE value, a
        # prior composite silently absent, a band crossing that demotes and
        # vanishes from the list that should name it.
        # Plant log: docs/engine_book/gates.md
        # + the rung / range / withdrawal gates and the FE fixture capture
        # (B8 verifier repair round, 2026-09-19): statements required on the
        # block, the as-filed withdrawal, the served re-check, a broken
        # pack refusing the block (never the period) and failing boot.
        Gate("ratio-credit-model",
             [PY, "-m", "pytest",
              "tests/engine/test_credit_model_pure.py",
              "tests/engine/test_credit_ladder_single_source.py",
              "tests/engine/test_credit_model_refusals.py",
              "tests/engine/test_credit_model_rungs_and_ranges.py",
              "tests/engine/test_credit_refusal_fe_fixture.py",
              # credit model revision 5 (owner ruling R1): the FE regime
              # fixture is the route's own bytes
              "tests/engine/test_credit_regime_fe_fixture.py",
              "tests/engine/test_period_route_revised_rows.py", "-q"],
             work_junit=True, floor=60, units="tests",
             canaries=("test_pure_rows_are_the_pre_extraction_rows_byte_for_byte",
                       "test_stage_compute_inserts_exactly_the_pure_rows",
                       "test_there_is_exactly_one_literal_ladder",
                       "test_a_book_with_no_liabilities_refuses_the_composite_and_the_letter_through_the_real_route",
                       "test_every_book_refuses_exactly_where_its_liabilities_are_below_the_model",
                       "test_the_block_and_the_refusals_take_no_rows_only_fallback",
                       "test_a_filed_altman_and_composite_outside_the_range_are_withdrawn_never_reprinted",
                       "test_a_broken_pack_refuses_the_credit_block_and_the_period_still_serves",
                       "test_the_fe_credit_fixture_is_what_the_route_serves_today",
                       "test_interest_coverage_divides_ebit_and_ebitda_to_interest_divides_ebitda",
                       "test_a_legacy_ebitda_basis_row_is_served_as_one_figure_on_every_surface",
                       "test_an_absent_debt_or_interest_leaf_declares_nothing")),
        Gate("ratio-table",
             [PY, "-m", "pytest", "tests/engine/test_ratio_table.py", "-q"],
             work_junit=True, floor=50, units="tests",
             canaries=("test_census_is_every_fe_row_plus_every_pack_banded_key",
                       "test_engine_value_is_the_printed_fe_value_on_every_shared_key",
                       "test_a_legacy_period_reads_the_served_assembled_bs_totals",
                       "test_a_value_on_a_rung_takes_that_rung")),
        Gate("ratio-compare",
             [PY, "-m", "pytest", "tests/engine/test_ratio_compare.py", "-q"],
             work_junit=True, floor=30, units="tests",
             canaries=("test_a_prior_with_no_persisted_metric_rows_still_carries_its_composite",
                       "test_printed_prior_plus_printed_delta_is_printed_current_on_every_row",
                       "test_materiality_is_the_hand_checked_figure_for_each_unit_on_the_real_pair")),
        Gate("ratio-band-findings",
             [PY, "-m", "pytest", "tests/engine/test_comparatives_bands.py", "-q"],
             work_junit=True, floor=55, units="tests",
             canaries=("test_a_planted_current_ratio_crossing_across_the_1_5_rung_surfaces_with_all_seven",
                       "test_a_two_period_finding_never_says_no_prior_period_was_supplied",
                       "test_no_finding_names_a_contra_account_and_subjects_rank_by_signed_amount",
                       "test_the_smallest_crossing_is_listed_with_its_surfaced_finding_and_no_floor_is_served",
                       "test_every_finding_carries_the_served_rows_figures_rung_headroom_severity_and_rank",
                       "test_a_served_code_the_contract_rejects_is_never_named_and_the_crossing_surfaces",
                       "test_the_movement_lists_partition_both_sides_and_demoted_crossings_stay_listed",
                       "test_a_lower_is_better_crossing_is_classified_by_direction",
                       "test_a_ratio_that_did_not_cross_produces_no_finding")),
        # THE SERVED-RANGE LAW (ruling R-RANGE; owner 2026-09-18: range gate
        # absolute). An independent law file that imports nothing from the
        # product, read against the real GET /api/period route over eight
        # books: the five scoring books, imbalance_03pct and
        # synthetic_thin_equity (no liabilities), the thin book carrying
        # exactly 1 RON of liabilities, the compact book with 1,000 of
        # long-term debt (R-D1's debt leg), synthetic_negative_equity (ROIC)
        # and the compact book with its revision-1 rows persisted (the
        # as-filed withdrawal). Plant log: docs/engine_book/gates.md.
        Gate("served-range",
             [PY, "-m", "pytest", "tests/engine/test_served_range.py", "-q"],
             work_junit=True, floor=44, units="tests",
             canaries=("test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason",
                       "test_the_zero_liability_books_refuse_altman_liquidity_the_composite_and_the_letter",
                       "test_one_ron_of_liabilities_is_not_a_capital_structure",
                       "test_the_law_is_independent_of_the_product",
                       "test_the_revision_1_filing_of_the_compact_book_is_withdrawn_on_the_route",
                       "test_the_r_d1_debt_leg_declares_no_rung_on_the_route",
                       "test_roic_refuses_on_the_route_when_invested_capital_is_not_positive")),
        # THE CREDIT SERVING BOUNDARY (owner, 2026-09-20: "the credit range
        # gate goes at the serving boundary so no fallback can bypass it").
        # create_app() over the tenancy double, a period whose persisted
        # revision-1 rows carry X4 1500 / Z'' 1584.89 / 88.5 AA, and the
        # model broken three ways (compute_period_metrics raises,
        # serve_time_metric_rows -> None, build_ratio_table raises): no such
        # figure, no zone and no letter on GET /api/period, the comparatives
        # prior or the narrator payload; the independent served_range_law on
        # every surface of every path. The bypass plant lives IN the suite.
        # Plant log: docs/engine_book/gates.md.
        Gate("credit-boundary",
             [PY, "-m", "pytest", "tests/engine/test_credit_boundary.py", "-q"],
             work_junit=True, floor=32, units="tests",
             canaries=("test_a_model_failure_path_serves_no_exploded_figure_no_zone_and_no_letter",
                       "test_with_the_boundary_bypassed_the_failure_path_serves_the_exploded_value",
                       "test_the_independent_law_holds_on_every_surface_of_every_path",
                       "test_the_comparatives_prior_serves_no_exploded_figure",
                       "test_the_narrator_payload_passes_the_boundary",
                       "test_the_boundary_fails_closed",
                       "test_every_credit_reader_in_the_api_layer_is_behind_the_boundary")),
        # THE FLOOR CENSUS, engine half (owner rule: absent is never zero and
        # never a floor). stdlib-ast over a printed 14-file scope for the
        # eight substitute classes of the floor sweep; the credit tier is
        # red on any unlisted site, the rest of the scope is a two-way
        # ratchet. Self-tests its own detection on a committed fixture every
        # run. Plant log: docs/engine_book/gates.md.
        Gate("floor-census", [PY, "scripts/check_floor_census.py"],
             work_rx=r"GATE-WORK floor-census units=(\d+)", floor=75,  # measured 79 after credit_model S8 4 -> 0 (feat/inventory-days; was 80 on 88 after the C6 floors merge)
             units="candidate sites",
             canaries=("self-test S1 DIVISOR_FLOOR",
                       "self-test S8 CONSTANT_PERIOD",
                       "credit   src/engine/ratios/credit_model.py",
                       "credit tier clean")),
        # The route the Ratios tab and the exports call, UN-INTERCEPTED:
        # create_app() itself over the tenancy double, a real ES256 bearer,
        # two corpus books as two periods of one workspace. Every FE ratio
        # gate renders a committed capture and the Playwright harness
        # answers the route from a file, so without this nothing on the
        # request path (mount, query binding, identity wall, org filter,
        # CAEN) is gated. Plant log: docs/engine_book/gates.md.
        Gate("comparatives-route",
             [PY, "-m", "pytest", "tests/engine/test_comparatives_route_real_app.py", "-q"],
             work_junit=True, floor=7, units="tests",
             canaries=("test_the_route_serves_every_ratio_and_a_numeric_prior_for_every_composite",
                       "test_the_committed_frontend_fixture_is_what_this_route_serves_for_the_pair",
                       "test_a_prior_from_another_workspace_is_not_found",
                       "test_a_current_period_from_another_workspace_is_not_found")),
        # DEPTH PARITY (2026-09-26): a compare column is each period's OWN
        # served figure — every ordered pair of the five real corpus books,
        # and each book beside its own four-digit re-aggregation through the
        # same assembler (the condensed-vs-ledger pair of the 09-23 incident,
        # where a month-replaced period printed another book's 2,727,103.68
        # under the client's label). Reds on a leaf read keyed by code depth,
        # a plugged bridge, a partial sum for a refusal, a code-listing label.
        # SERVED PATH (later the same day, after the nine-line verifier P1):
        # the offline half now reads SERVED-SHAPED envelopes (persisted
        # columns only, legacy buckets only), and every real book plus its
        # condensed counterpart is also carried through the real persist seam
        # into the tenancy double and read back through create_app()'s own
        # GET /api/period and /comparatives routes for all 30 served pairs.
        # Reds on coverage matched on the persisted names again (a non-zero
        # served sub-aggregate reading "neither period reported"), a mover
        # ranking that is not the columns' own, a second composition on the
        # route. Floor 200 = the measured 225. Plant log: docs/engine_book/gates.md.
        Gate("comparatives-depth-parity",
             [PY, "-m", "pytest", "tests/engine/test_comparatives_depth_parity.py", "-q"],
             work_junit=True, floor=200, units="tests",
             canaries=("test_every_headline_column_is_each_periods_own_served_figure_on_every_real_pair",
                       "test_a_book_against_its_own_4_digit_re_aggregation_moves_nothing_on_the_pl",
                       "test_the_pl_roll_up_is_measured_lossless_on_every_real_book",
                       "test_a_headline_the_prior_cannot_build_is_an_honest_refusal_never_a_partial_sum",
                       "test_the_incident_pair_serves_each_books_own_revenue_so_only_the_period_content_can_print_another_books_figure",
                       "test_every_headline_a_period_holds_is_its_served_figure_through_the_real_routes",
                       "test_the_nine_sub_aggregate_lines_are_reported_through_the_real_route_wherever_a_period_holds_them",
                       "test_the_top_movers_are_the_served_columns_own_ranking_through_the_real_route",
                       "test_the_served_document_is_compare_payloads_over_the_two_bodies_the_same_app_served")),
        # "CE CONTEAZĂ ACUM" (attention/1, design C1, 2026-09-26): the command
        # bar's empty state, one engine authority. Three gates:
        #   attention-rules        the declared rules on served documents —
        #                          reds on Other equity or the composite
        #                          letter as "the biggest movement", a band
        #                          crossing ahead of a statutory result, a
        #                          filler, a filed-basis stock row with a
        #                          verdict word, a prior of another length.
        #   attention-served-only  every item figure IS the served object at
        #                          its declared path; model text planted in
        #                          recommendations / briefing / alerts /
        #                          insight narratives changes nothing.
        #   attention-route        GET /attention un-intercepted on
        #                          create_app(): the same-length prior, the
        #                          wall, composition == the served documents,
        #                          network off. Plant log: gates.md.
        Gate("attention-rules",
             [PY, "-m", "pytest", "tests/engine/test_attention_rules.py", "-q"],
             # release r-rulings (2026-09-28): the served inventory-days block
             # read with its label and policy, no fallback formula (measured 29).
             # Owner ruling R4 (2026-09-28): "Exportă raportul pentru bancă" is
             # the CFO Report PDF in every action state, never the Forecast;
             # the composer takes no feature statuses and the pack refuses an
             # action carrying a feature gate / a target / an unknown name
             # (measured 31).
             work_junit=True, floor=31, units="tests",
             canaries=("test_other_equity_is_never_the_biggest_movement_on_the_served_pair",
                       "test_the_bank_report_is_the_cfo_report_pdf_never_the_forecast",
                       "test_the_actions_cannot_read_the_feature_registry",
                       "test_no_served_block_is_no_claim_and_no_fallback_formula",
                       "test_the_served_block_is_read_with_its_basis_label_and_its_policy",
                       "test_the_composite_letter_is_never_the_biggest_movement",
                       "test_a_single_period_company_fills_the_slots_from_its_findings",
                       "test_the_empty_state_differs_between_two_companies",
                       # stage CB-H: an item's receiver heads with its own figure
                       "test_every_insight_item_opens_a_receiver_that_heads_with_its_own_figure",
                       "test_a_receiver_that_heads_with_another_figure_is_declined_for_the_cited_accounts")),
        Gate("attention-served-only",
             [PY, "-m", "pytest", "tests/engine/test_attention_served_only.py", "-q", "-s"],
             work_rx=r"GATE-WORK attention-served-only items=(\d+)", floor=15,
             units="item figures traced to their served source",
             canaries=("SCOPE attention-served-only sentinel worlds=",
                       "GATE-WORK attention-served-only items=")),
        Gate("attention-route",
             [PY, "-m", "pytest", "tests/engine/test_attention_route_real_app.py", "-q"],
             # owner ruling R4 (2026-09-28): the bank report served as the CFO
             # Report PDF with the Forecast feature ON and OFF in the served
             # registry (measured 10).
             work_junit=True, floor=10, units="tests",
             canaries=("test_the_route_serves_the_company_against_its_same_length_prior",
                       "test_the_bank_report_is_the_cfo_report_pdf_whatever_the_forecast_registry_says",
                       "test_the_route_composes_exactly_what_the_same_app_serves",
                       "test_an_explicit_prior_is_read_inside_the_workspace_only",
                       "test_a_current_period_from_another_workspace_is_not_found")),
        # THE COMMAND BAR (⌘K), frontend stage CB-F1 (design C2/C3/C5):
        #   cmdbar-fixtures  the empty-state fixtures the frontend gates render
        #                    ARE the engine's composition, byte for byte; the
        #                    bar's statement names are the attention pack's
        #                    (one metric, one name); every synonym joins a
        #                    served line / ratio / sector row.
        #   cmdbar-surface   the REAL CommandPalette over served documents:
        #                    the swap test, every Răspuns/Cont figure equal to
        #                    the served figure (ratio_table, never metrics[]),
        #                    no model call and no model text, < 100 ms and
        #                    ZERO fetches per keystroke, "loading" never blank
        #                    or 0 when cold, the digit rule, synonyms, typos,
        #                    the caveat once, the rent-only DSCR only for a
        #                    rental company. Stage CB-G (design C5) made the
        #                    figure law exhaustive — every Cont leaf of both
        #                    books in RO and EN, every Δ against its
        #                    comparatives column, every vs-sector against its
        #                    sector row — and added the cold open timed, the
        #                    rendered synonyms/diacritics and the keyboard
        #                    flow (incl. a new, shorter query selecting its own
        #                    answer — a defect the live G8 found) and every
        #                    document it asks for named to ITS company (a
        #                    cross-company request workspace-v2 G6 found);
        #                    stage CB-I (review round 1): a company or period
        #                    switch paints nothing of what was left behind and
        #                    asks nothing across companies, on the APP's query
        #                    defaults (keepPreviousData) — cmdbarSwitch; the
        #                    zero-fetch law waits out a debounce horizon on
        #                    fake timers; only a digit word is a code, a mixed
        #                    word finds the name that carries it; review
        #                    round 2: the bar's OWN "Switch to <company>" (and
        #                    a company × year row, and its recent pick) opens
        #                    that company's screen and stays switched past the
        #                    hold's ask window, from every kind of screen, with
        #                    the redesign on (the screen's hold is the ONE
        #                    authority) and off (the bar switches in the same
        #                    tick), never mid-scan — cmdbarSwitchAction; and a
        #                    ?org= link over the previous period's kept payload
        #                    is held for its pin — dashboardCompanyHold; the
        #                    switchingTo guard proven (cmdbarSwitch "in
        #                    flight"); a code wrapped in punctuation is the
        #                    code; the latency laws hold the keystroke's WORK
        #                    on the thread's CPU clock (test/cpuClock) and the
        #                    zero-fetch law fakes Date and performance too, so
        #                    a lodash (Date-measured) debounce is counted.
        #                    floor = the measured count, exact. Live half (hermetic
        #                    bundle, not in the battery — it needs a build):
        #                    e2e/design/cmdbar.spec.ts G0-G11.
        #                    Plant log: docs/engine_book/gates.md.
        Gate("cmdbar-fixtures",
             [PY, "-m", "pytest", "tests/engine/test_cmdbar_fixtures.py", "-q", "-s"],
             work_rx=r"GATE-WORK cmdbar-fixtures documents=(\d+)", floor=6,
             units="engine-composed documents re-composed and compared",
             canaries=("GATE-WORK cmdbar-fixtures documents=",)),
        Gate("cmdbar-surface",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/instrument/shell/__tests__/commandBar.test.tsx",
              "frontend/components/instrument/shell/cmdbar/__tests__/cmdbarSearch.test.ts",
              "frontend/components/instrument/shell/cmdbar/__tests__/cmdbarStrings.test.ts",
              "frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx",
              "frontend/components/cfo/chat/__tests__/roleChips.test.tsx",
              "frontend/lib/__tests__/companyFit.test.ts",
              "frontend/components/cfo/__tests__/evidenceReceivers.test.tsx",
              "frontend/components/instrument/shell/__tests__/cmdbarSwitch.test.tsx",
              "frontend/components/instrument/shell/__tests__/cmdbarSwitchAction.test.tsx",
              "frontend/pages/cfo/__tests__/dashboardCompanyHold.test.tsx",
              "--reporter=verbose"],
             # release r-rulings (2026-09-28): the served inventory-days block,
             # no sector chip beside the split, a refusal in the engine's words
             # (measured 190); fixer round 1: refused total equity / operating
             # result in the engine's words, the 711 note (measured 201);
             # owner ticket 2026-09-28 (every figure in the reader's
             # language): cmdbar-ui-language, three worlds x EN/RO (measured
             # 207); owner rulings 2026-09-29 (every WORD too): a finding in
             # years and an unmeasured one, EN/RO (measured 209).
             # Owner ruling R4 (2026-09-28): the bank report opens the CFO
             # Report PDF, at rest / typed / from a pre-ruling recent, Forecast
             # OFF and ON (measured 206 on the rulings lineage, +5).
             # release r-rulings2 (2026-10-01): both lineages merged —
             # 209 + the five R4 tests (214), + the regime line in the
             # reader's language, EN/RO (measured 216).
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=216,
             units="command-bar tests",
             canaries=("the rows ARE the served items, in the served rank, each with its figure",
                       "inventory days are the served block — its figure, its basis label, no filed-basis row beside it",
                       "a period that serves NO block prints that reason",
                       "a refused EBITDA prints the engine's own words",
                       "two companies, one fixture shape: different figures (S1) and different words (S2)",
                       "every ratio answer is its ratio_table row, never metrics[]",
                       "warm: every keystroke renders under 100 ms and fetches NOTHING",
                       "planted model text in every field the bar must not read never reaches it",
                       "a code one digit off never silently picks another account",
                       "one caveat node, referenced by the listbox, never repeated on an item",
                       "any other company (or an unknown one) is never offered the rent-only DSCR",
                       "the bar's link lands on the drawer for that ratio, and closing it drops the parameter",
                       # stage CB-G (design C5): the laws held exhaustively
                       "GATE-WORK cmdbar-cont-leaves agras/ro leaves=",
                       "each statement answer's Δ is the served column through the shared printers",
                       "each vs-sector position is the served sector row",
                       "cold: every statement answer's VALUE renders under 100 ms",
                       "every spelling of a subject",
                       "↓ walks every row and stops on 'Ask CFO AI'",
                       "diacritics no other rule rescues",
                       "Romanian is written with its own letters",
                       "typing the name the bar prints for a figure opens that figure first",
                       "a new query selects ITS answer even when the old selection sat below",
                       "carry the period's company as X-Org-Id",
                       # stage CB-H (review fixes, 2026-09-27)
                       "GATE-WORK cmdbar-whole-code agras prefixes=",
                       "agras: '401' lists the 401 accounts — never 167.401, 628.401 or 709.401",
                       "'4111': the three largest leaves by served balance, then ONE row counting the rest and opening all six",
                       "at rest and typed, every carrier on every row is outside any truncating box",
                       "display EUR: every money figure is the served RON figure with its code",
                       # stage CB-I (review round 1, 2026-09-27)
                       "GATE-WORK cmdbar-switch company \"the bar open, at rest\"",
                       "GATE-WORK cmdbar-switch company \"the bar closed through the switch",
                       "GATE-WORK cmdbar-switch period \"rest\"",
                       "fetches NOTHING — not even after a debounce",
                       "GATE-WORK cmdbar-code-word agras mixed_name_words=",
                       "a code word never meets a NAME word that starts with its digits",
                       # review round 2 of stage CB-I (2026-09-27)
                       "GATE-WORK cmdbar-switch-action redesign=on pick=action from=\"Scandia's dashboard\"",
                       "GATE-WORK cmdbar-switch-action redesign=off pick=page from=\"/settings\"",
                       "with an analysis running, the pick moves nothing and switches nothing",
                       "a ?org= link over the PREVIOUS period's kept payload: the pin decides",
                       "GATE-WORK cmdbar-switch in-flight",
                       "GATE-WORK cmdbar-wrapped-code agras probes=",
                       "GATE-WORK cmdbar-latency warm keystrokes=",
                       "GATE-WORK cmdbar-latency cold answers=",
                       "GATE-WORK cmdbar-selection-frames queries=",
                       # release r-rulings, fixer round 1 (2026-09-28)
                       "total equity the engine refuses AS total equity prints the engine's words",
                       # fixer round 2: the prior's refusal NAMED AS THE PRIOR'S on
                       # all four guarded answers (replaces the law that pinned the
                       # bare sentence)
                       "a prior the engine refused on a line carries no Δ — its refusal NAMED AS THE PRIOR'S",
                       "GATE-WORK cmdbar-prior-refused answers=",
                       "g6_uncleared: a refused operating result prints the one-EBITDA refusal in the engine's words",
                       "GATE-WORK cmdbar-711-note scandia/ro rows=",
                       "GATE-WORK cmdbar-711-note agras/en rows=",
                       "a note on each 711 leaf and on nothing else",
                       "a 711 row on a book whose variation the engine REFUSED says so in the engine's words",
                       # owner ticket 2026-09-28: every figure in the reader's language
                       "GATE-WORK cmdbar-ui-language scandia/en figures=",
                       "GATE-WORK cmdbar-ui-language agras/ro figures=",
                       "scandia (en): no figure at rest or typed is in the other language's format; turnover reads 48.3M RON",
                       "agras (ro): no figure at rest or typed is in the other language's format; turnover reads 110,8 mil. RON",
                       "ro: 12,5 ani and neraportat; no word of the other language in the bar",
                       # owner ruling R4 (2026-09-28): "Exportă raportul pentru
                       # bancă" opens the CFO Report PDF — at rest, typed and
                       # from a pre-ruling recent pick, Forecast OFF and ON
                       "at rest: \"Exportă raportul pentru bancă\" opens the export tab (Forecast active)",
                       "typed: every bank word finds ONE export row, the CFO Report PDF (Forecast active)",
                       "a recent pick saved before the ruling (it opened the Forecast) opens the CFO Report PDF",
                       # release r-rulings2 (2026-10-01): the R1 regime line
                       # under the reader's-language ruling
                       "GATE-WORK cmdbar-ui-language regime/en figures=",
                       "GATE-WORK cmdbar-ui-language regime/ro figures=")),
        # EVERY FIGURE IN THE READER'S LANGUAGE (owner ticket 2026-09-28: the
        # ENGLISH interface printed "413,7 mil. RON" on the command bar, the
        # workspace cards and the company page, and the report's days
        # fallback "1 days" — lib/money chose the locale from the currency):
        #   ui-language-figures  lib/money's one mapping (moneyLocaleFor) and
        #                    its printers, <Money> across a live language
        #                    switch, the table formatter, the workspace home
        #                    card and the company page's year tiles, the bar's
        #                    served-money and finding-measure printers — each
        #                    the owner's string in EN ("413.7M RON") and RO
        #                    ("413,7 mil. RON") with no number in the other
        #                    language's format on the surface
        #                    (frontend/test/numberLanguage.ts); the report's
        #                    days fallback agreeing with its count. The
        #                    rendered bar is cmdbar-surface's
        #                    cmdbar-ui-language; live, cmdbar.spec.ts G6.
        #                    Plant log: docs/engine_book/gates.md.
        Gate("ui-language-figures",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/pages/cfo/__tests__/figuresFollowUiLanguage.test.tsx",
              "--reporter=verbose"],
             # rulings 2026-09-29: + every word (finding units, the absent
             # case, the engine's count nouns), the tooltip rate, the cockpit
             # printers and every bilingual string the engine serves the
             # cockpit and the margin note (measured 35; 20 before).
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=35,
             units="reader's-language figure tests",
             canaries=("GATE-WORK ui-language-figures figures=",
                       "every string from the ticket reads as Romanian on an English surface; the English strings do not",
                       "en: the served value in the owner's format, every currency with its code after the figure",
                       "one mounted <Money> and one table cell re-print on a language switch — no remount",
                       "en: Scandia 413.7M RON, Agras 110.8M RON; no number in the other language's format",
                       "en: 2025 413.7M RON, 2024 380M RON, 2023 350M RON; no number in the other language's format",
                       "bound to a language, it prints that language whatever the global state; unbound, the active one",
                       "a finding's measure (the resting items, the evidence drawer's headline) in the printer's language",
                       "1 → 1 day",
                       "every count noun the engine's detectors emit is worded in both languages",
                       "5.2489 in English, 5,2489 in Romanian — the same digits",
                       "compact and full money are lib/money's, in the page's language, cents under one unit",
                       "every bilingual string the engine serves the cockpit and the margin note")),
        # A COMPARISON THAT IS ON SAYS WHAT IT COMPARES — OR THAT IT COMPARES
        # NOTHING (production, 2026-10-04: a company's EARLIEST year on screen,
        # "Previous year (auto)" selected, the Prior / Δ / Δ % / share boxes
        # ticked, and the P&L, balance sheet and cash flow each showed one
        # column with no word why — no balance for the year before existed, so
        # AUTO resolved to nothing and the controls went on implying a
        # comparison):
        #   compare-no-prior  the dashboard's comparison controls and notice
        #                    over the one rule (comparisonChoiceOf): with the
        #                    comparison ON and no prior, AUTO's option names
        #                    the balance it looked for as missing (never one
        #                    that is in the list at another length), a notice
        #                    below the sticky bar says which balance is
        #                    missing and offers the upload and up to three
        #                    EARLIER periods one click away (never a later
        #                    one), every column box is disabled and unticked,
        #                    the reader's stored columns are untouched; month
        #                    names in the reader's language; with a prior, no
        #                    notice and no disabled box; no document of
        #                    another pair on screen (the app's own query
        #                    defaults; ratioSurfacesOf); the page hands both
        #                    the prior it requests on the same five tabs; the
        #                    upload links are routed and a finished upload
        #                    refreshes the period lists. Eight company shapes
        #                    x period on screen x six stored choices.
        #                    Plant log: docs/engine_book/gates.md.
        Gate("compare-no-prior",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/cfo/__tests__/comparativesNoPrior.test.tsx",
              "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=26,
             units="comparison-state tests",
             canaries=("GATE-WORK compare-no-prior states=",
                       "ro: the picker names the missing balance, the notice says why and what to do, every box is off",
                       "en: the picker names the missing balance, the notice says why and what to do, every box is off",
                       "the rule resolves no prior, and does not pick the later year in its place",
                       "ro: every month in the sentence is a Romanian month",
                       "the reader's columns survive the no-prior state: off while nothing is compared, back as stored",
                       "every company shape \u00d7 period on screen \u00d7 stored choice",
                       "stepping from a compared period to one with no prior: the previous document is gone",
                       "a document of another pair, or with no request, is no document",
                       "fed by the choice the request is made with",
                       "every upload link of the comparison goes to a path the app routes",
                       "each key, with its placeholders, in both bundles \u2014 and the two differ")),
        # THE EVIDENCE RECEIVERS, frontend stage CB-F2 (design C4):
        #   evidence-lines   the account view's statement lines ARE the
        #                    engine's comparatives lines: the served path,
        #                    the buckets that feed each (a derived line's
        #                    declared constituents sum to its served figure),
        #                    every line a link can name declared, one name.
        #   cmdbar-evidence  EVERY link the bar builds — each "Ce contează
        #                    acum" item, every Cont row, every Răspuns row —
        #                    opened on the receiver the page mounts
        #                    (EvidenceDrawer ?account= / ?line=, RatiosTab
        #                    ?ratio=, /benchmark?row=) lands on a rendered,
        #                    HIGHLIGHTED target that is the thing it named;
        #                    no total the engine did not serve, never 0 for
        #                    an absent account, no retired tab slug in source.
        #                    Plant log: docs/engine_book/gates.md.
        Gate("evidence-lines",
             [PY, "-m", "pytest", "tests/engine/test_evidence_lines.py", "-q", "-s"],
             work_rx=r"GATE-WORK evidence-lines lines=(\d+)", floor=12,
             units="evidence lines held to the engine's line registry",
             # fixer round 2 (2026-09-28): every line's listed feeds sum to
             # its served figure on both committed bodies, none a 711 leaf.
             canaries=("GATE-WORK evidence-lines lines=",
                       "GATE-WORK evidence-lines feeds=")),
        Gate("cmdbar-evidence",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/cfo/evidence/__tests__/evidenceLanding.test.tsx",
              "frontend/pages/cfo/__tests__/benchmarkRowReceiver.test.tsx",
              "--reporter=verbose"],
             # release r-rulings, fixer round 1 (2026-09-28): the 711 note
             # and label in the account view, refused lines in the engine's
             # words (measured 45); fixer round 2: the feeds law and the 711
             # label over every account view (measured 47).
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=47,
             units="evidence-landing tests",
             canaries=("scandia: each served item opens a rendered, highlighted target that IS the item",
                       "pair: each served item opens a rendered, highlighted target that IS the item",
                       "scandia: every served line item's Cont row opens the account view on that exact leaf (model, all rows)",
                       "agras: every ratio answer lands on its ratio-table row (tile or not)",
                       "a synthetic code shows its leaves and NO total the engine did not serve",
                       "no source file links a statement tab by a slug the dashboard does not have",
                       # stage CB-H (review fixes, 2026-09-27)
                       "earnings_quality opens under ITS number (758 + 781), then the accounts it cites",
                       "GATE-WORK cmdbar-cont-overflow agras probes=",
                       "legacy report caen_not_set: the sector section renders and marks the row the bar named",
                       "display EUR: the account view prints the SERVED RON balance with its code",
                       # stage CB-I (review round 1, 2026-09-27)
                       "en: a finding this period does not serve is said in words",
                       "ro: a finding this period does not serve is said in words",
                       # review round 1 of stage CB-I, second pass (2026-09-27)
                       "GATE-WORK cmdbar-evidence-words en views=",
                       "GATE-WORK cmdbar-evidence-words ro views=",
                       # release r-rulings, fixer round 1 (2026-09-28)
                       "ro: a 711 leaf opens labelled as its credit turnover (never a balance)",
                       "every view that lists a 711 leaf carries the note once",
                       "a 711 leaf on a book whose variation the engine REFUSED carries that refusal",
                       "a refused operating result and a refused total equity open on the engine's words",
                       # release r-rulings, fixer round 2 (2026-09-28): a line's
                       # feeds are the leaves its figure sums, never a 711 leaf;
                       # a 711 row in a mixed table names its own amount
                       "THE FEEDS ARE THE FIGURE",
                       "GATE-WORK cmdbar-evidence-feeds lines=",
                       "GATE-WORK cmdbar-evidence-711-label views=")),
        # FLOOR SUBSTITUTES, batch C3 (owner rulings R-D5 / R-D6 / R-OTHER,
        # 2026-09-15): the valuation DCF, the AI briefing's citable
        # ratios, the RO pack's ROA check and the served period day count.
        # Every defect it covers served a believable number built on a
        # figure the book never yielded (1 RON equity, a 5% cost of debt, a
        # 0 FCF, 1e-9 EBITDA, 365 days). Floor 44 = the measured 48.
        # Plant log: docs/engine_book/gates.md
        Gate("floor-valuation",
             [PY, "-m", "pytest", "tests/engine/test_floor_dcf.py",
              "tests/engine/test_floor_period_days.py",
              "tests/engine/test_floor_briefing_ratios.py", "-q"],
             work_junit=True, floor=44, units="tests",
             canaries=("test_dcf_refuses_when_book_equity_is_not_positive",
                       "test_a_measured_implied_cost_of_debt_is_used_even_below_the_old_floor",
                       "test_recompute_answers_400_on_an_out_of_domain_override",
                       "test_a_31_december_corpus_book_serves_exactly_the_bytes_it_served_before",
                       "test_stage_narrate_hands_the_model_refusals_not_fabricated_ratios")),
        # parser v6 (owner ruling 2026-09-18) was ported onto production as
        # its own deploy with its own statements-anchor-gap registration;
        # on this lineage the gate is the ONE plan/2 B4a registration
        # above (same test file, floor and canaries — one name, one gate).
        # The 0.32 / 0.3257 seam (owner, 2026-09-21): every printed
        # interest coverage divides the EBIT the P&L prints
        # (`assembled_pl.ebit`) and equals its own recomputation to the
        # printed digit, on the four corpus books and the Scandia
        # baseline through the real GET /api/period. The frontend halves
        # are vitest (interestCoverageBasis, exportRatioFormulas G4, and
        # interestCoveragePopover — the Ratios card's learning popover,
        # whose printed operands must divide, as printed, to the card on
        # every corpus book with interest). The popover's corpus fixture is
        # held fresh here (test_coverage_popover_corpus_fixture): the scope
        # is discovered from corpus/, so a book added with interest reds
        # until the fixture carries it.
        # Plant log: docs/engine_book/gates.md.
        Gate("interest-coverage-one-operand",
             [PY, "-m", "pytest", "tests/engine/test_interest_coverage_one_operand.py",
              "tests/engine/test_coverage_popover_corpus_fixture.py", "-q"],
             work_rx=r"GATE-WORK interest-coverage-one-operand units=(\d+)", floor=8,  # measured 9: 5 books + 4 with interest
             units="books served and coverages recomputed",
             canaries=("SCOPE interest-coverage-one-operand",
                       # the test's TC-3 line since the one-EBITDA rewrite
                       # (0e48c078): the discriminating operand is the
                       # pre-ruling EBIT, not operating_ebit (now one figure)
                       "books where the pre-ruling EBIT (without 711 / 72x) would print a "
                       "different coverage: 2",
                       "retail             EBIT 786579.83",
                       "SCOPE coverage popover corpus fixture")),
        # The battery's own preflight (the nested node_modules link) and the
        # playwright gate's refusals — unknown flag, stack not running — run
        # for real against local recorders. No suite is started.
        Gate("battery-preflight",
             [PY, "-m", "pytest", "tests/engine/test_battery_preflight.py",
              "tests/engine/test_playwright_gate_refusals.py", "-q"],
             work_junit=True, floor=16, units="tests",
             canaries=("test_a_planted_nested_link_stops_the_battery_before_any_gate",
                       "test_the_main_checkout_has_no_nested_node_modules_today",
                       "test_nothing_listening_is_stack_not_running_never_a_failure_count",
                       "test_an_unknown_flag_is_refused_and_runs_nothing",
                       "test_the_baseline_file_holds_each_key_once")),
        Gate("cron-auth",
             [PY, "-m", "pytest", "tests/engine/test_cron_auth.py", "-q"],
             work_junit=True, floor=8, units="tests",
             canaries=("test_cron_without_a_configured_token_is_503_never_run",
                       "test_cron_with_a_wrong_bearer_is_refused")),
        # NO SCHEDULED MAIL REACHES A PERSON WHO IS NOT ENTITLED TO IT,
        # CARRIES ANOTHER TENANT'S DATA, OR GOES OUT TWICE (owner ticket
        # 2026-10-02, the audit before the Firm Cockpit flag flips). The
        # crons and drains read under the SERVICE ROLE — the filter the
        # code writes is the access control. Through the REAL create_app()
        # over the tenancy suite's two-firm world, the provider replaced by
        # a recorder: the renewal reminder goes to the SUBSCRIBER (it went
        # to the first membership by role.asc — the firm's accountant); a
        # digest names only what its recipient reads today (no other firm's
        # request, no archived client, no archived firm); entitlement is
        # decided again at send time (a removed member, an opt-out, a
        # revoked request, a cancelled subscription); every queue row is
        # CLAIMED before the provider is called and every cron claims
        # before it queues (one run, two runs, two interleaved runs, a
        # failed mark-sent write: one mail); the drains refuse everyone but
        # the operator; every function that queues or sends mail is on a
        # census. cron-auth above holds the crons' 503 / 401. Measured 39.
        # Plant log: docs/engine_book/gates.md "scheduled-mail-tenancy".
        Gate("scheduled-mail-tenancy",
             [PY, "-m", "pytest",
              "tests/engine/test_scheduled_mail_renewals.py",
              "tests/engine/test_scheduled_mail_digest.py",
              "tests/engine/test_scheduled_mail_requests.py",
              "tests/engine/test_scheduled_mail_census.py",
              "tests/engine/test_supabase_update_returning.py", "-q"],
             work_junit=True, floor=39, units="tests",
             canaries=("test_the_renewal_reminder_goes_to_the_subscriber_never_to_a_teammate",
                       "test_running_the_renewal_cron_twice_queues_one_reminder",
                       "test_each_member_is_mailed_their_own_firms_live_clients_and_nothing_else",
                       "test_a_request_another_firm_minted_never_reaches_this_firms_digest",
                       "test_an_archived_client_is_in_no_digest",
                       "test_a_member_removed_between_the_cron_and_the_drain_is_not_mailed",
                       "test_two_interleaved_runs_queue_one_digest",
                       "test_no_reminder_for_a_request_whose_firm_no_longer_serves_the_client",
                       "test_every_function_that_queues_or_sends_mail_is_classified",
                       "test_update_returning_sends_the_filter_and_asks_for_the_changed_rows")),
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
        # ── owner ruling 2026-09-26, design A8 (stage G1): the EEI audited
        # canonical validator (CI tier1) was a law of the OLD rule —
        # "operational view excluded 722". Rewritten: 722 (2,164,079.83) is
        # inside EBITDA and outside turnover, counted ONCE on the no-anchor
        # path (build-up + 722 = account 121), EBIT = EBITDA − D&A, 711 is
        # 0.00 no_711_activity. Registered by name so a collapse of its
        # assertion list is visible. Measured 31 PASS lines. Plant log:
        # gates.md "eei-canonical".
        Gate("eei-canonical", [PY, "scripts/validate_eei_canonical.py"],
             work_count_rx=r"^  PASS  ", floor=28,
             units="audited EEI assertions",
             canaries=("PL  EBITDA = before stock variation + 722",
                       "PL  build-up + 722 = account 121 (722 once)",
                       "PASS — All audited EEI canonical assertions passed.")),
        # ── F3.1-PARITY (stage G1, 2026-09-27): the byte-identical parity
        # pair (eei_dec_2025, scandia_fy2025) re-captured under the one-
        # EBITDA ruling with the stock-variation evidence the write seam
        # measures threaded through; it was RED at the production base
        # (stale since before the ruling) and unregistered. Plant log:
        # gates.md "f31-parity".
        Gate("f31-parity", [PY, "scripts/check_assembled_parity.py"],
             work_count_rx=r"^\s+GREEN\s+\S+\s+byte-identical", floor=2,
             units="parity fixtures byte-identical",
             canaries=("GREEN  eei_dec_2025", "GREEN  scandia_fy2025",
                       "Overall: GREEN — F3.1-PARITY gate passes")),
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
        # ── FLOOR C6-C8 (wave/floor-c6-public-sku, 2026-09-18) ──────────
        # The owner's rule "absent is never zero and never a floor" over the
        # three non-credit clusters of the floor sweep (scratchpad/specs/
        # floor_sweep.json): public risk/opportunity scores (C6), the SKU /
        # portfolio engine (C7), industry detection (C8). Each defect served
        # a number where none was defined — a neutral 50 for a company with
        # no financials, a 20,000% portfolio margin over a 1.0 divisor, a
        # real-estate CAEN read off absent cost lines — and nothing crashed.
        # Named separately from `pytest` so the battery record shows them.
        # Plant log: docs/engine_book/gates.md § floor-public-score,
        # § floor-sku-portfolio, § floor-industry-absent.
        # 2026-09-19 repair round: the ai-market-read fallback joined the
        # public gate (its watch sentence claimed a composite that had
        # refused); the SKU gate gained the served anchorProfitShare and
        # DIO-sheet period-range refusals two verifier plants had shown were
        # ungated; the industry gate now drives the real /report router.
        # R-PUBLIC-ABSENT (2026-09-19): the producer-coverage file joined —
        # a category no producer can fill is dropped with its weight
        # redistributed and the coverage stated; a per-company gap still
        # refuses; the declaration is measured against the producers.
        Gate("floor-public-score",
             [PY, "-m", "pytest",
              "tests/engine/public/intelligence/test_risk_scoring_engine.py",
              "tests/engine/public/intelligence/test_opportunity_scoring_engine.py",
              "tests/engine/public/intelligence/test_public_score_refusal_route.py",
              "tests/engine/public/intelligence/test_ai_market_read.py",
              "tests/engine/public/intelligence/test_risk_producer_coverage.py",
              "-q"],
             work_junit=True, floor=52, units="tests",
             canaries=("test_no_financials_refuses_every_financial_category_and_the_composite",
                       "test_snapshot_boundary_converts_points_and_keeps_a_measured_zero",
                       "test_no_financials_refuses_instead_of_scoring_medium",
                       "test_top_risk_contribution_is_null_when_every_mapped_category_is_refused",
                       "test_fallback_watch_flags_state_a_refused_composite_not_composite_low",
                       "test_the_declaration_is_measured_against_the_live_producers",
                       "test_a_per_company_absence_still_refuses_the_category_and_the_composite",
                       "test_per_ticker_route_serves_the_composite_with_its_coverage_block")),
        Gate("floor-sku-portfolio",
             [PY, "-m", "pytest", "tests/engine/test_floor_sku_portfolio.py",
              "tests/test_metrics.py", "-q"],
             work_junit=True, floor=42, units="tests",
             canaries=("test_skus_share_of_category_profit_refuses_net_zero",
                       "test_zero_volume_dio_rows_fall_through_to_the_upload_sheet",
                       "test_zero_revenue_category_is_refused_not_eliminated",
                       "test_composite_score_dio_zero_is_undefined",
                       "test_classify_rows_refuses_anchor_profit_share_when_profit_nets_to_a_loss",
                       "test_dio_sheet_out_of_range_banner_span_is_not_used",
                       "test_analyze_route_states_refused_roic_and_share_instead_of_500")),
        Gate("floor-industry-absent",
             [PY, "-m", "pytest",
              "tests/engine/test_industry_classifier_absent_inputs.py", "-q"],
             work_junit=True, floor=15, units="tests",
             canaries=("test_metrics_without_cost_lines_refuse_instead_of_suggesting_real_estate",
                       "test_detect_industry_for_period_reads_the_pl_line_items",
                       "test_report_route_gates_a_no_line_items_period_with_the_refusal",
                       # one-EBITDA ruling (stage G1): shares over net turnover
                       "test_every_share_divides_net_turnover_never_total_operating_revenue",
                       "test_without_net_turnover_the_classification_refuses")),
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
        # 2026-09-29 (owner ruling: independent of a checkout's dotenv): the
        # subject is every env a test path reads — the vitest manifest
        # (always present, its hosts checked unreachable), the process env
        # vite gives priority, and dotenv files where a checkout has them.
        # A worktree / CI with no dotenv used to examine 0 and go red.
        # Floor = the manifest's 14 variables: a run that did not read it reds.
        Gate("test-env-isolation",
             ["node", "scripts/check_test_env_isolation.mjs"],
             work_rx=r"units=(\d+)", floor=14,
             units="env vars examined",
             canaries=("TEST-ENV ISOLATION", "sanctioned supabase",
                       "sources examined     : frontend/test/hermeticEnv.json (14)")),
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
        # ── plan/2 B0 (plan_contract_v2 28.3): forecast-boundary ─────────
        # F2's static half, already written and never in the battery. Reds
        # on a zero-file scan and prints, by name, the Scenarios files it
        # does not yet hold (they join at B13). Floor 1000 = the measured
        # 1,167 files (761 ts + 406 py), rounded down.
        Gate("forecast-boundary", ["node", "scripts/check_forecast_boundary.mjs"],
             work_rx=r"GATE-WORK forecast-boundary units=(\d+)", floor=1000,
             units="ts+py files scanned",
             canaries=("FORECAST BOUNDARY GATE (F2, static half)",
                       "forecast-namespace consumers found")),
        # ── end plan/2 B0 ────────────────────────────────────────────────
        # ── plan/2 B13 (minimal cut, 2026-09-21): the Scenarios page's import
        # closure. Same script as forecast-boundary; its own work count and
        # canaries, so a closure that stops being walked is loud here even
        # while the file scan above still clears its floor. Measured closure:
        # 78 modules.
        Gate("scenarios-closure", ["node", "scripts/check_forecast_boundary.mjs"],
             work_rx=r"GATE-WORK forecast-boundary-scenarios units=(\d+)", floor=40,
             units="modules in the Scenarios page's import closure",
             canaries=("in the Scenarios closure: frontend/pages/cfo/Scenarios.tsx",
                       "in the Scenarios closure: frontend/components/scenarios/ScenarioOutcome.tsx",
                       # B13 repair (2026-09-21): the page-owned files are also
                       # read for value reads and type escapes (plants A/B/C in
                       # gates.md); a rule that stops running is loud here.
                       "page-owned, checked for value reads and type escapes: frontend/pages/cfo/Scenarios.tsx",
                       "page-owned, checked for value reads and type escapes: frontend/components/scenarios/ScenarioOutcome.tsx")),
        # ── end plan/2 B13 ───────────────────────────────────────────────
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
        # 2026-09-29 (owner ruling: the 11 findings it carried are not a
        # baseline): the findings are on design_review/PROVENANCE_BURNDOWN.json
        # with owners; the gate fails on any finding NOT listed (a new one, or
        # a listed file drifting further) and on a listed one that no longer
        # occurs (the list only shrinks). The open count prints every run and
        # is reported weekly.
        Gate("provenance-census", ["node", "scripts/check_provenance_census.mjs"],
             work_rx=r"GATE-WORK provenance-sites units=(\d+)", floor=80,
             units="figure render sites",
             canaries=("PROVENANCE CENSUS", "GATE-WORK provenance-census",
                       "GATE-WORK provenance-burndown open=")),
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
        # VITEST — 2,784 frontend unit tests that were OUTSIDE the battery
        # until 2026-09-08. `tsc` and `npm-build` were in it; nothing ran
        # the suite. Same shape as the `check_tsc` false green above, and
        # it was RED when first wired: an engine mirror had drifted, and
        # the mirror test that exists to catch that had been passing on a
        # quoted phrase lifted out of a Python COMMENT. The gate prints
        # how many tests ran and names one file per area, because a suite
        # matching nothing exits zero and reports 2,784 -> 0 silently.
        # 2026-09-29 (owner ruling: a gate whose canary is missing is
        # vacuous): every canary is the gate's "<file>: ran" line, never the
        # bare file name — the bare name also matched "<file>: NEVER RAN",
        # which is how forecastPage.test.tsx (retired in 131061f6) stayed a
        # "seen" canary here for a week. Floor re-measured (4,336 tests).
        Gate("vitest", ["node", "scripts/check_vitest.mjs"],
             work_rx=r"GATE-WORK vitest units=(\d+)", floor=3900,
             units="frontend unit tests",
             canaries=("capsuleFactIndex.test.ts: ran",
                       "frontend/pages/cfo/__tests__/forecastCockpit.test.tsx: ran",
                       "socialLinksFromConfig.test.ts: ran",
                       # plan/2 B1 (S7, section 7): the TS classifier
                       # against the shared truth table, and the rendered
                       # sign flips on every converted consumer.
                       "frontend/lib/__tests__/changeKind.test.ts: ran",
                       "frontend/components/scenarios/__tests__/signFlip.test.tsx: ran",
                       # plan/2 B6 (F2, F4, F6): the fp1.2 reader over the
                       # real served bytes, and the magnitude band whose
                       # early returns became reds.
                       "frontend/lib/__tests__/forecastFactsReader.test.ts: ran",
                       "frontend/pages/cfo/__tests__/forecastMagnitude.test.tsx: ran",
                       # plan/2 B13 (minimal cut): the Scenarios page on the
                       # engine, rendered over the real served bytes.
                       "frontend/pages/cfo/__tests__/scenariosEngine.test.tsx: ran",
                       # forecast-scenarios-live: F1 / F5 / F6 on the pages.
                       "frontend/components/forecast/__tests__/forecastYearZero.test.tsx: ran",
                       "frontend/pages/cfo/__tests__/scenariosSaved.test.tsx: ran")),
        # RATIO BYTE-MATCH — the owner's "same columns, same numbers,
        # byte-matching" as a gate. It also rides `vitest`, and is named on
        # its own because its defect prints a believable figure on one
        # surface: a rounding, a unit or a joined change cell that differs
        # between the Ratios tab, the report and the workbook while every
        # per-surface gate stays green (it did, on the merged B6+B7 state:
        # 68 of 70 red). Plant log: docs/engine_book/gates.md.
        Gate("ratio-byte-match",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/lib/__tests__/ratioTableByteMatch.test.tsx", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=120,
             units="row x surface comparisons",
             canaries=("B4 non-vacuity: every census row and composite is compared",
                       "B1/B2 altman_z: the tab, the report and the workbook print the same six cells",
                       "B5 altman_z: the same name beside the six cells",
                       "B5 the six column headings are one string",
                       "B3 the deteriorated list: the served order and the same cells",
                       "B6 non-vacuity: every named path is extracted whole and is the real served-row path")),
        # THE BRIEFING CARD MAKES NO MODEL CALL WITHOUT A CLICK, AND A PLAN
        # REFUSAL IS RENDERED FROM ITS CODE (hotfix 2026-10-02, SPEC D4 /
        # D10; rulings 2026-10-03). It also rides `vitest`, and is named on
        # its own because both halves fail SILENTLY: an effect that fires
        # the regenerate route on a language mismatch or a currency toggle
        # spends the reader's allowance with no click (every bundle deployed
        # before the hotfix did exactly that, unmetered), and a humanizer
        # that prints the server's message shows one member's plan to
        # another. The card over a recorded fetch: no request on mount, on a
        # language mismatch, on a currency toggle; ONE per click with the
        # explicit-intent body (the fixture the engine gate posts to the
        # real route); an action that creates or replaces the STORED
        # briefing asks for RON whatever the display currency; a failure
        # keeps the prose and is shown stale only when the engine says the
        # row is; a stored regeneration is SHOWN whatever the display
        # currency; 422 / 429 / 503 print a sentence, never the server's
        # words. Measured 77. Plant log: gates.md
        # "briefing-explicit-regenerate".
        Gate("briefing-explicit-regenerate",
             ["npx", "vitest", "run", "--root", ".",
              "frontend/components/cfo/__tests__/briefingExplicitRegenerate.test.tsx",
              "frontend/lib/__tests__/uploadRefusalCodes.test.ts", "--reporter=verbose"],
             work_rx=r"Tests\s+(?:\d+ failed \| )?(\d+) passed", floor=77,
             units="tests",
             canaries=("on mount: no request, and no action offered when language and currency already match",
                       "on a currency toggle: no request",
                       "a click sends ONE POST: no query string, the explicit-intent body",
                       "with the display currency EUR, 'Generate the briefing' asks for RON",
                       "a stored 'Generate the briefing' is SHOWN at once",
                       "the same failure with stale:true IS presented as kept",
                       "a row that still carries a server message never prints it",
                       "the card's source holds no effect-driven request")),
        Gate("npm-build", ["npm", "run", "build"],
             work_rx=r"(\d+) modules transformed", floor=1000,
             units="modules transformed",
             canaries=("dist/index.html",)),
        # PLAYWRIGHT — the last suite outside the net until 2026-09-09, and
        # it had already taken the battery down once by starving vitest of
        # CPU. Baseline measured serially on a quiet machine with the dev
        # server up AND the engine restarted from HEAD: 339 ran, 29 skipped,
        # 171 known failures.
        #
        # RE-RECORDED 2026-09-09. The first baseline (174) was measured
        # against an engine started six days earlier, which predated a
        # feature-registry change and answered 36 features where HEAD
        # answers 47. Restarting :8000 from HEAD moved 31 tests to passing
        # and 28 to failing — a two-way swing of 59 on a net of 3, which is
        # why a baseline is only meaningful against a build you have
        # identified. HEAD's registry was then checked against PRODUCTION's
        # /api/features/status and matches it exactly, so this baseline
        # measures what ships. Of the 171, seven are launch-route-cut
        # asserting a cut that production no longer applies. That ratio is
        # not healthy, and the baseline is NOT a certificate that it is —
        # design_review/PLAYWRIGHT_BASELINE.txt may only SHRINK, so the
        # gate reds on a NEW failure and accepts a repaired one.
        #
        # Requires a dev server on :5173 (playwright.config.ts's webServer
        # block is commented out — "locally we assume it's up"), so the gate
        # reds rather than silently baselining an empty run: it floors the
        # ran count and ceilings the skip rate. It also REFUSES any spec
        # naming an absolute non-local origin, after
        # learning-landing-onboarding.spec.ts was found fetching
        # https://cfo-ai.io/ on every run.
        Gate("playwright", ["node", "scripts/check_playwright.mjs"],
             work_rx=r"GATE-WORK playwright units=(\d+)", floor=305,
             units="e2e tests run",
             canaries=("launch-route-cut.spec.ts",
                       "golden-path.spec.ts",
                       "currency-coverage.spec.ts")),
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


# ──────────────────────────────────────────────────────────────────────
# PREFLIGHT — the nested node_modules link
#
# Every worktree links its node_modules to the main checkout's. `ln -s
# <main>/node_modules <worktree>/node_modules` run a SECOND time on a
# worktree that already has the link follows the existing link and creates
# the new one INSIDE the target: <main>/node_modules/node_modules. A second
# copy of @playwright/test is then on the resolution path of every checkout
# and Playwright collects zero tests in zero files — and the link came back
# within the hour on 2026-10-02, after it had been removed. So the battery
# looks before it runs anything: the link present is a RED with its own
# name, never a quiet cause of some other gate's number.
#
# The rule for whoever makes the link: `ln -sfn` (replace, never follow),
# never a bare `ln -s` on a path that may already exist.
# ──────────────────────────────────────────────────────────────────────

def _main_checkout() -> Path:
    """The MAIN checkout of this repository — the tree every worktree's
    node_modules link points into. In the main checkout it is REPO."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=REPO, capture_output=True, text=True, timeout=30)
        common = Path(proc.stdout.strip())
        if proc.returncode == 0 and common.name == ".git":
            return common.parent
    except (OSError, subprocess.SubprocessError):
        pass
    return REPO


def nested_node_modules(checkouts) -> List[Path]:
    """Every `node_modules/node_modules` that exists under the given
    checkouts — as a link (live or broken) or as a directory — each real
    location once. A worktree whose node_modules is itself a link reaches
    the same entry as the main checkout (the path is resolved through the
    link), so it is named once, at its real location."""
    found: List[Path] = []
    seen = set()
    for root in checkouts:
        outer = Path(root) / "node_modules"
        if not os.path.lexists(outer / "node_modules"):
            continue
        key = os.path.join(os.path.realpath(outer), "node_modules")
        if key not in seen:
            seen.add(key)
            found.append(Path(key))
    return found


def preflight() -> List[str]:
    """What must be true before any gate runs; a non-empty list is a RED
    and no gate is started."""
    problems = []
    for nested in nested_node_modules([_main_checkout(), REPO]):
        problems.append(
            "nested-node-modules: %s exists. A second copy of every package "
            "is then on the resolution path of every checkout (Playwright "
            "collects ZERO tests). It is made by a bare `ln -s` run twice on "
            "a worktree's node_modules link. Remove that one entry "
            "(`rm %s`), and link worktrees with `ln -sfn`." % (nested, nested))
    return problems


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

    problems = preflight()
    if problems:
        print("BATTERY PREFLIGHT")
        print("=" * 62)
        for problem in problems:
            print("RED — %s" % problem)
        print("")
        print("FAIL — the battery did not start: %d preflight problem(s), "
              "0 gates run." % len(problems))
        return 1

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
