"""NO RUN REPLACES A USABLE BRIEFING WITH A FAILED NARRATION — the writers' seam.

Gate `briefing-keep-last-good`, the part that is NOT the regenerate route:
`stage_persist_narrative` (every re-run of an analysed document reaches it on
the SAME period row), `_finalize_same_month_takeover` (a same-month
re-upload), the Docs panel's re-run (POST /api/pipeline/retry) and the SKU
writer (`_persist_sku_analysis`). Hotfix 2 SPEC, decisions D6b, D6c, D7 and
the last bullet of D9, and the owner's rulings of 2026-10-03.

OWNER RULING (2026-10-02, verbatim): "a failed regenerate must NEVER overwrite
a stored briefing with [NARRATIVE_UNAVAILABLE] — keep the last good one, mark
it stale."

OWNER RULINGS (2026-10-03, as relayed to this repair by the coordinator —
the law where the SPEC is silent):
  · "Scope: everything the gate tests belongs in this hotfix, including the
    re-run route, the SKU briefing overwrite and the period-read defect."
  · "Takeover: keep the month's recommendations too. A takeover must not
    delete anything that was good."

THE DEFECT (measured on 91fc4e24 — scout_briefing §0 and §6). `briefings`
holds ONE row per period and no history, so an overwritten briefing is gone:

  · a re-run whose narration failed upserted the failure text over the stored
    briefing — the provider sentinel, or the operator sentence "Set
    ANTHROPIC_API_KEY on the backend to enable AI narrative.", or a fragment
    of a reply that was not JSON — AND deleted the period's recommendations
    (statuses, owners and due dates a user had set on them included);
  · the same-month takeover deleted the month's briefing and moved the staged
    run's row — its failure text — into its place;
  · every write stamped `language: "en"`, whatever the prose was written in.

THE LAW.
  W1  A failed narration over a usable stored row: the row is byte-identical
      (the two marker columns aside), the period's recommendations are kept
      exactly, the row is marked stale by a SEPARATE update filtered by
      period_id AND org_id, and the run's deterministic alerts are written.
      The stored row is read with the tenant in the filter.
  W2  A failed narration with nothing to protect (a first analysis) stores
      exactly "[NARRATIVE_UNAVAILABLE]" — whatever text the branch returned.
  W3  A failed narration over a stored failure text stores the sentinel —
      and NEVER deletes the period's recommendations, whatever the briefing
      row holds (ruling 2026-10-03; R3 below).
  W4  A usable narration IS written: body, the TRUE language (clamped to
      en / ro), the model `_narrative_model()` names, the EBITDA definition
      stamp (a literal of this file, over a row stamped with the previous
      revision); the marker cleared by a separate update; the
      recommendations replaced by the run's. Also over a stored failure
      text (the recovery cell).
  W5  The marker columns are never in a briefing upsert; with
      supabase/schema_phase_briefing_stale.sql NOT applied every law above
      still holds (the marker simply is not stored) — at the direct seam
      AND through the orchestrator (W6, W7).
  W6  Through the real orchestrator: a re-run whose narration fails leaves
      the served briefing and recommendations intact — the engine's own
      re-run of a document on its period row, AND the one a user starts
      from the Docs panel (POST /api/pipeline/retry; R2 below).
  W7  Through the real pipeline: a same-month re-upload whose narration fails
      replaces the month's statements but not its usable briefing NOR ITS
      RECOMMENDATIONS (ruling 2026-10-03), marks the briefing stale with the
      run's own code, and leaves nothing under the staged id (what the
      staged run left in those two tables deleted with the tenant in the
      filter). All four cells of served usable/unusable x staged
      usable/unusable, and a staged run that left NO briefing row (R1).
  W8  Every failure result of the real `stage_narrate` can be persisted.
  W9  A period that vanished mid-run: no write, no raise.
  W10 The run's deterministic alerts are written in EVERY case — also when
      a briefing or recommendation write raises. The raise still reaches
      the caller (the orchestrator logs it as non-fatal).
  W11 A narration's recommendations are validated BEFORE the destructive
      delete: an item that is an object is coerced to what its columns
      hold; a `recommendations` that cannot be read (a string, an object, a
      list holding no object) replaces NOTHING — the stored ones are kept.
  W12 The SKU writer follows the same rule (ruling 2026-10-03; R6 below).

REPAIRED 2026-10-03 (branch repair/briefing-writers). The gate was written
RED against the hotfix's own code (d3c955a7: 31 of 114 cases); each defect
below was repaired in src/engine/api/pipeline.py, and none of its tests was
skipped or weakened. Where the SPEC was silent the owner ruled (above) and
the test asserts the ruling.
  R1  The takeover when the staged run left NO briefing row (its
      `stage_persist_narrative` raised — swallowed as non-fatal — or the AI
      lane, which never narrates) deleted the month's usable briefing and
      put nothing in its place. The keep decision required a staged row to
      exist. Now: no staged row is not a replacement.
        test_a_same_month_reupload_whose_staged_briefing_write_fails_…  (pipeline)
        test_a_takeover_whose_staged_run_left_no_briefing_row_…         (seam)
  R2  The Docs panel's "Re-run analysis" deletes the document's period
      BEFORE the run (production's foreign keys cascade the briefing and
      the recommendations away): keep-last-good never engaged. Now the
      reset stays as it was and what it takes is CARRIED across it and put
      back when the run's narration brings nothing — the briefing as it
      was, marked stale; the recommendations with their statuses, owners
      and due dates, whatever the briefing row held. (A first repair ran
      the re-run in place; review found three wrong states and it was
      withdrawn — see the W6 section.)
        test_a_docs_panel_rerun_…, test_the_reset_is_what_it_always_was_…,
        test_the_carry_holds_only_…, test_carried_recommendations_…
  R3  A failed narration over a stored FAILURE text (or no briefing row)
      deleted the period's recommendations — the state the pre-repair
      regenerate left in production. RULED: never.
        test_a_failed_narration_never_deletes_the_periods_recommendations_…
  R4  A USABLE narration whose `recommendations` is not the list of objects
      asked for: briefing replaced, recommendations deleted, a raise, the
      alerts never written. Now W10 and W11.
        test_a_usable_briefing_with_malformed_recommendations_…
  R5  What the predicate calls unavailable — a dict without
      `recommendations`, a non-dict — made the writer raise after its
      destructive writes. A failed narration now reads no recommendations.
        test_whatever_the_predicate_calls_unavailable_…
  R6  The SKU scope: `_persist_sku_analysis` stored a failed narration over
      a usable `sku_analyses.briefing` and emptied its recommendations.
      RULED in scope.
        test_a_failed_narration_never_replaces_a_usable_sku_briefing

DECIDED BY THE REPAIR (the rulings do not dictate these; each is reported).
  · UNREADABLE recommendations (W11) keep the stored ones — an unreadable
    reply is not "the model recommends nothing". An EMPTY list does replace.
  · A staged run that left no briefing row beside a month whose own
    briefing is a failure text: the month's row is left as it is.
  · The kept briefing of a takeover whose staged run delivered no briefing
    and no code (a write that was lost, the AI lane) is marked `empty_reply`.
  · The carry of a Docs-panel re-run lives in process memory: a re-run
    whose RUN fails leaves no period (as it always did) and the carry waits
    for the document's next re-run; a restart in between loses it.
  · A period that cannot be read refuses the re-run (503 `rerun_unavailable`)
    rather than being reset blind.
  · A recommendations INSERT the database refuses after the delete puts the
    period's previous recommendations back (the raise still reaches the
    caller).
  · A takeover whose staged period row is gone refuses (`StagedPeriodGone`)
    and touches nothing of the month; one whose run wrote no alerts keeps
    the month's.

OBSERVED — NOT ASSERTED (reported to the owner).
  · With the stale migration NOT applied, a briefing kept by a failed
    re-run or a failed takeover is served with `stale: null` — nothing
    durable says it is the previous file's prose beside the new numbers
    (D7's "carried by the regenerate response" exists only for the route).
  · The Docs-panel re-run is unmetered (an analysed document's correction,
    by design) and still calls the provider.
  · A Docs-panel re-run whose RUN fails leaves the document `failed` and NO
    period, as it always did (the reset is production's); what the reset
    took waits in the carry — in this process — for the document's next run.

WHAT RUNS HERE. Neither writer is stubbed, and no expectation is taken from
the code under test (the sentinel, the six codes, the marker columns, the
definition stamps and every expected string are written out below).
  · The direct seam: the REAL `stage_narrate` over the agras corpus book —
    only the PROVIDER is doubled (`anthropic.Anthropic`, or the environment a
    branch reads) — handed to the REAL `stage_persist_narrative` (and the
    real `_persist_sku_analysis`, the real `_finalize_same_month_takeover`)
    over `firm_postgrest_double.PostgrestDouble`, which refuses a column no
    migration declares. `RecordingDouble` records every write WITH its
    payload, and models the stale migration not yet applied.
  · The orchestrator: `_run_pipeline_sync` in the `gw` world of
    test_workspace_v2_gates — the real upload routes, the real POST
    /api/pipeline/retry, the real stages from `stage_extract` to
    `stage_persist_narrative`, the real `_finalize_same_month_takeover`,
    the real GET /api/period — with the provider scripted per run and every
    write on the double spied. One test makes the DATABASE refuse a write
    (a timeout on the staged briefing upsert).

WHAT THESE RED ON, with the defect repaired (TC-11):
  · a failed narration upserting anything over a usable briefing, or
    deleting / re-inserting the period's recommendations;
  · the writer deciding on the body text instead of the structured code (a
    reply fragment is prose to the text predicate);
  · the stored briefing read without the tenant in the filter;
  · the alerts not written when the briefing is kept;
  · the marker written inside an upsert, without `org_id` in its filter,
    carrying provider text, or moving `stale_since` on a second failure;
  · a first analysis storing provider text, an operator sentence or a reply
    fragment; a stored failure text surviving, or the function raising;
  · a usable narration not written, stamped `en` for Romanian prose,
    stamped with a model other than `_narrative_model()`, not stamped with
    today's EBITDA definition, left stale, or the superseded
    recommendations left beside the run's;
  · any briefing write depending on the stale migration — in the writer,
    in a re-run or in the takeover;
  · the takeover replacing the month's usable briefing with a staged failure
    text, leaving any row under the staged id, deleting the staged
    briefing without the tenant in the filter, not marking the kept row,
    marking it with the staged row's text code instead of the run's code,
    keeping a stored FAILURE text as if it were the last good one, or no
    longer replacing the briefing when the staged narration IS usable;
  · the takeover deleting the month's briefing when the staged run left NO
    briefing row; deleting the month's recommendations when the staged
    narration is unusable, its recommendations unreadable or its narrative
    write raised; leaving staged recommendations behind, or deleting them
    without the tenant in the filter; no longer replacing the month's
    recommendations when the staged narration IS usable and readable;
  · the run's alerts not written because a briefing or recommendation
    write raised — or that raise swallowed inside the writer;
  · a malformed `recommendations` raising, or costing the period its stored
    recommendations; an object item with a null rationale or numeric
    actions no longer stored; an EMPTY list no longer replacing;
  · the Docs-panel re-run no longer resetting the period (the in-place
    design is withdrawn), or resetting it without carrying its usable
    briefing and recommendations; the carry read without the tenant; a
    re-run whose narration fails — or whose narrative write the database
    refuses — serving less than before the click; the carry let go before
    the run is durable; a carried briefing re-stamped as this run's;
  · the SKU writer storing a failed narration over a usable briefing,
    anything but the sentinel on a failed first analysis, recommendations
    over a stored row on a failure, or reading the stored row without the
    tenant in the filter; a usable narration no longer written;
  · a failure branch of `stage_narrate` dropping a key the writer reads;
  · a write for a period that no longer exists.

CANNOT SEE.
  · PostgREST itself: the real merge-duplicates upsert, the `language in
    ('en','ro')` check, `body not null`, the foreign keys' ON DELETE CASCADE
    (the double models none; W6 models the period's cascade itself,
    `_cascade_period_deletes`), or whether the migration is applied in
    production.
  · A stored reply FRAGMENT: the text predicate cannot tell it from prose, so
    it is kept as "usable" (D5 lists what is recognised; a fragment is not).
  · The regenerate route and the served shape (the sibling files of this
    gate), and two runs racing.
  · The AI lane END TO END (it needs its activation gates): its takeover
    call — `_finalize_same_month_takeover(doc, period_id)`, no narration,
    no staged briefing row — is driven at the seam only (R1).
  · move-period / make-active (`_period_move`): they delete and move
    `briefings` rows through `_DERIVED_TABLES` — a table-name VARIABLE the
    literal census below cannot read — and then re-run the document; and
    the other re-run entries (recover-stuck, the watchdog).
  · A briefings upsert whose table name is not the literal "briefings" (the
    static census reads literals).
  · The SKU writer's kept case relies on PostgREST's merge-duplicates
    upsert leaving the columns a payload does not name (the doubles model
    it; `sku_analyses.briefing` / `.recommendations` are nullable, so the
    partial row is a valid insert candidate) — and what GET
    /api/sku-analysis/latest SERVES for a stored sentinel is not driven.
  · The Docs-panel re-run's re-file record is in-process: a restart
    between POST /api/pipeline/retry and the run loses it, and the old
    period of a re-filed document then stays (nothing is deleted).
  · The AI lane's re-run (its periods hold no briefing, so they are reset
    as before — only the reset itself is driven here, on a classical
    period holding a failure text).

PLANT LOG: docs/engine_book/gates.md "briefing-keep-last-good".
"""
from __future__ import annotations

import ast
import copy
import json
import sys
import types
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import pytest

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine.api import pipeline as P
from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION

REPO = Path(__file__).resolve().parents[2]

ORG = "0b1e0000-0000-4000-8000-0000000b1ef0"        # the workspace under test
OTHER_ORG = "0b1e0000-0000-4000-8000-0000000b1eff"  # another tenant, never touched
PID = "b1ef0000-0000-4000-8000-0000000b1ef0"
OTHER_PID = "b1ef0000-0000-4000-8000-0000000b1eff"
DOC_ID = "doc-keep-last-good"

# ── THE EXPECTED VALUES, stated here — never read from the code under test ──

#: The one failure text the product stores (SPEC D5 / D6b).
SENTINEL = "[NARRATIVE_UNAVAILABLE]"
#: The marker columns of supabase/schema_phase_briefing_stale.sql (SPEC D7).
STALE_COLUMNS = ("stale_since", "stale_reason")
#: The neutral codes (SPEC D5) — the only values `stale_reason` may hold.
NEUTRAL_CODES = ("no_api_key", "sdk_missing", "provider_error",
                 "unparseable_reply", "empty_reply", "withheld_numerals")

#: The EBITDA definition a briefing written TODAY is stamped with, and the
#: revision before it — written out, so the stamp is asserted against a
#: value the writer did not hand us (a row seeded with the engine's own
#: constant made that assertion vacuous: the upsert MERGES, and a payload
#: that stopped naming the column left the seed in place).
CURRENT_DEFINITION = ("ebitda/2026-09-28:711-72x-inside,767-financial,"
                      "provisions-6812-6814-7812-7814-outside,7411-turnover")
PREVIOUS_DEFINITION = "ebitda/2026-09-26:711-72x-inside,767-financial"

#: The last good briefing, and the next one.
GOOD_BODY = ("Vânzările au crescut față de anul trecut, marja operațională s-a "
             "menținut, iar lichiditatea rămâne adecvată.")
NEW_BODY = ("Compania își finanțează creșterea din surse proprii; ciclul de "
            "numerar s-a scurtat, iar îndatorarea rămâne redusă.")
NEW_RECOMMENDATION = "Scurtează termenele de încasare"

#: What the provider says when the credit is gone (production, 2026-09-20).
PROVIDER_ERROR_TEXT = (
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', "
    "'message': 'Your credit balance is too low to access the Anthropic API.'}}")
#: A reply that is not JSON: prose to any text predicate.
REPLY_FRAGMENT = ("I'm sorry, but I can't produce the JSON you asked for. Here is "
                  "what I can say about the company instead: revenue")
REPLY_JSON_LIST = '["not", "the", "object", "asked", "for"]'

#: Nothing of these may ever be stored in a briefings row.
FORBIDDEN_IN_A_STORED_ROW = ("ANTHROPIC_API_KEY", "SDK not installed", "credit balance",
                             "invalid_request_error", "Error code", "I'm sorry",
                             "asked", "withheld", "Narrative unavailable")

#: The run's deterministic alerts (the shape `stage_validate` hands on).
RUN_ALERTS = [
    {"alert_key": "liquidity_cash_ratio_low", "rule_key": "cash_ratio_low", "severity": "high",
     "category": "liquidity", "title": "Cash ratio below 0.10",
     "body": "Cash covers less than a tenth of the short-term liabilities."},
    {"alert_key": "leverage_net_debt_to_ebitda_high", "rule_key": "net_debt_to_ebitda_high",
     "severity": "medium", "category": "leverage", "title": "Net debt above four times EBITDA",
     "body": "Net debt is more than four times EBITDA."},
]
RUN_ALERT_KEYS = ["leverage_net_debt_to_ebitda_high", "liquidity_cash_ratio_low"]
OLD_ALERT_KEY = "rule_of_the_previous_run"


# ══════════════════════════════════════════════════════════════════════
# The PROVIDER double (the direct seam)
# ══════════════════════════════════════════════════════════════════════


class _Reply(object):
    """What `client.messages.create` returns: text blocks."""

    def __init__(self, text: str) -> None:
        self.content = [types.SimpleNamespace(type="text", text=text)]


def _install_provider(monkeypatch, behaviour: Callable[[Dict[str, Any]], Any]) -> List[Dict[str, Any]]:
    """`anthropic.Anthropic` whose `messages.create` is `behaviour` — the
    only thing replaced on the narrate side. Returns the requests it saw."""
    requests = []  # type: List[Dict[str, Any]]

    class _Messages(object):
        def create(self, **kwargs: Any) -> Any:
            requests.append(kwargs)
            return behaviour(kwargs)

    class _Anthropic(object):
        def __init__(self, **_kw: Any) -> None:
            self.messages = _Messages()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-a-key")
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Anthropic))
    return requests


def _provider_raises(_kw: Dict[str, Any]) -> Any:
    raise RuntimeError(PROVIDER_ERROR_TEXT)


#: Every failure branch of the REAL `stage_narrate`:
#: id -> (the neutral code, the `briefing` text the branch returns — SPEC D5:
#: the code rides "beside the unchanged `briefing` value").
REAL_FAILURES = {
    "no_api_key": ("no_api_key", "Set ANTHROPIC_API_KEY on the backend to enable AI narrative."),
    "sdk_missing": ("sdk_missing", "anthropic SDK not installed on backend."),
    "provider_raises": ("provider_error", "[NARRATIVE_UNAVAILABLE]"),
    "reply_is_not_json": ("unparseable_reply", REPLY_FRAGMENT),
    "reply_is_a_json_list": ("unparseable_reply", REPLY_JSON_LIST),
    "reply_is_empty": ("empty_reply", "Narrative unavailable."),
    "reply_has_a_null_briefing": ("empty_reply", "Narrative unavailable."),
    # The guard's fixed sentence (engine.ai.numerals): its first words.
    "numerals_withheld": ("withheld_numerals", "The briefing was withheld:"),
}  # type: Dict[str, Tuple[str, str]]
_TEXT_IS_A_PREFIX = ("numerals_withheld",)

_PROVIDER_REPLIES = {
    "reply_is_not_json": REPLY_FRAGMENT,
    "reply_is_a_json_list": REPLY_JSON_LIST,
    "reply_is_empty": "",
    "reply_has_a_null_briefing": '{"briefing": null, "recommendations": []}',
    "numerals_withheld": json.dumps({"briefing": "Revenue was 987,654,321 RON and the margin 77.7%.",
                                     "recommendations": []}),
}

#: Two results the real `stage_narrate` does not return today, which a writer
#: must still never store over a usable briefing (SPEC D6: "no writer may
#: replace a usable briefing with an unusable one"; D7: "neutral code only").
HAND_BUILT_FAILURES = {
    # The provider branch before 2026-08-04: its text, and no code at all.
    "a_result_without_a_code_holding_provider_text": {
        "briefing": "Narrative unavailable: " + PROVIDER_ERROR_TEXT, "recommendations": [], "alerts": []},
    # A code that is not one of the six — provider text in the code's place.
    "a_code_that_is_provider_text": {
        "briefing": SENTINEL, "recommendations": [], "alerts": [],
        "unavailable": "Error code: 529 - {'type': 'overloaded_error'}"},
}
ALL_FAILURES = sorted(REAL_FAILURES) + sorted(HAND_BUILT_FAILURES)

#: The reply of a narration that worked.
USABLE_REPLY = {
    "briefing": NEW_BODY,
    "recommendations": [{
        "severity": "high", "category": "financial", "title": NEW_RECOMMENDATION,
        "rationale": "Creanțele se încasează mai lent decât se plătesc furnizorii.",
        "actions": ["Revizuiește termenele contractuale", "Urmărește săptămânal restanțele"],
        "estimated_ron_impact": None, "metric_referenced": "dso"}],
}


def _doc(language: Optional[str] = "ro") -> Dict[str, Any]:
    doc = dict(SB.book("agras").doc, id=DOC_ID, org_id=ORG)
    if language is not None:
        doc["detected_language"] = language
    return doc


def _narrate(language: Optional[str]) -> Dict[str, Any]:
    """The REAL `stage_narrate` over the agras corpus book."""
    bk = SB.book("agras")
    return P.stage_narrate(_doc(language), copy.deepcopy(bk.persist_assembled), [],
                           {"industry_key": "generic"}, period_id=PID, parsed=bk.parsed)


def _real_failed_narration(monkeypatch, branch: str,
                           language: Optional[str] = "ro") -> Tuple[Dict[str, Any], str]:
    """A FAILED narration out of the real `stage_narrate`, by its branch."""
    code, text = REAL_FAILURES[branch]
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    if branch == "no_api_key":
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    elif branch == "sdk_missing":
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-a-key")
        monkeypatch.setitem(sys.modules, "anthropic", None)  # the import raises ImportError
    elif branch == "provider_raises":
        _install_provider(monkeypatch, _provider_raises)
    else:
        reply = _PROVIDER_REPLIES[branch]
        _install_provider(monkeypatch, lambda _kw: _Reply(reply))
        if branch == "numerals_withheld":
            monkeypatch.setenv("AI_NUMERAL_GUARD", "enforce")
    narration = _narrate(language)
    # PRECONDITIONS (stage_narrate's own contract, D5) — without them the
    # laws below would be about some other input.
    assert isinstance(narration, dict), "stage_narrate[%s] returned %r" % (branch, narration)
    assert narration.get("unavailable") == code, (
        "PRECONDITION: stage_narrate[%s] must return unavailable=%r, got %r"
        % (branch, code, narration.get("unavailable")))
    body = narration.get("briefing")
    if branch in _TEXT_IS_A_PREFIX:
        assert isinstance(body, str) and body.startswith(text), (branch, body)
    else:
        assert body == text, "PRECONDITION: stage_narrate[%s] text %r, got %r" % (branch, text, body)
    return narration, code


def _failed_narration(monkeypatch, branch: str) -> Tuple[Dict[str, Any], Optional[str]]:
    """(the narration, the exact code the marker must carry — None for a
    hand-built result, whose marker must be SOME neutral code)."""
    if branch in HAND_BUILT_FAILURES:
        return copy.deepcopy(HAND_BUILT_FAILURES[branch]), None
    return _real_failed_narration(monkeypatch, branch)


def _real_usable_narration(monkeypatch, language: Optional[str] = "ro"
                           ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """A USABLE narration out of the real `stage_narrate`, and the provider
    requests it made."""
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    requests = _install_provider(
        monkeypatch, lambda _kw: _Reply(json.dumps(USABLE_REPLY, ensure_ascii=False)))
    narration = _narrate(language)
    assert narration.get("briefing") == NEW_BODY and not narration.get("unavailable"), (
        "PRECONDITION: the real stage_narrate must return the usable reply: %r" % (narration,))
    return narration, requests


# ══════════════════════════════════════════════════════════════════════
# The DATABASE double (the direct seam)
# ══════════════════════════════════════════════════════════════════════


class RecordingDouble(D.PostgrestDouble):
    """The projection-faithful PostgREST double (it refuses a table or a
    column no migration declares, as production answers 400 42703), which
    also records every WRITE with its payload and filters — refused ones
    too. `stale_migration_applied=False` is `briefings` as it stands before
    supabase/schema_phase_briefing_stale.sql is run."""

    def __init__(self, *, stale_migration_applied: bool = True, every_table: bool = False) -> None:
        # `every_table`: all the tables the migrations declare (the takeover
        # and the SKU writer reach tables the narrative writer does not).
        columns = V._all_migration_columns() if every_table else RA.migration_columns()
        if not stale_migration_applied:
            columns["briefings"] = [c for c in columns["briefings"] if c not in STALE_COLUMNS]
        super(RecordingDouble, self).__init__(columns=columns)
        self.writes = []  # type: List[Dict[str, Any]]

    def _attempt(self, op: str, table: str, payload: Any = None,
                 filters: Optional[Dict[str, str]] = None,
                 on_conflict: Optional[str] = None) -> Dict[str, Any]:
        entry = {"op": op, "table": table, "payload": copy.deepcopy(payload),
                 "filters": dict(filters or {}), "on_conflict": on_conflict, "refused": False}
        self.writes.append(entry)
        return entry

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        entry = self._attempt("insert", table, rows)
        try:
            return super(RecordingDouble, self).insert(table, rows, returning=returning)
        except Exception:
            entry["refused"] = True
            raise

    def upsert(self, table: str, rows: Any, *, on_conflict: Optional[str] = None,
               returning: bool = True) -> List[Dict[str, Any]]:
        entry = self._attempt("upsert", table, rows, on_conflict=on_conflict)
        try:
            return super(RecordingDouble, self).upsert(table, rows, on_conflict=on_conflict,
                                                       returning=returning)
        except Exception:
            entry["refused"] = True
            raise

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        entry = self._attempt("update", table, patch, filters=filters)
        try:
            return super(RecordingDouble, self).update(table, patch, filters=filters)
        except Exception:
            entry["refused"] = True
            raise

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        self._attempt("delete", table, filters=filters)
        return super(RecordingDouble, self).delete(table, filters=filters)


def _writes(double: Any, table: str, op: Optional[str] = None) -> List[Dict[str, Any]]:
    return [w for w in double.writes if w["table"] == table and (op is None or w["op"] == op)]


def _of_period(double: RecordingDouble, table: str, period_id: str = PID) -> List[Dict[str, Any]]:
    return [r for r in double.rows(table) if r.get("period_id") == period_id]


def _foreign(double: RecordingDouble) -> Dict[str, List[Dict[str, Any]]]:
    """Everything the OTHER tenant holds — it must come out of every
    scenario exactly as it went in."""
    return dict((t, copy.deepcopy([r for r in double.rows(t) if r.get("org_id") == OTHER_ORG]))
                for t in ("briefings", "recommendations", "alerts"))


def _sans_marker(row: Dict[str, Any]) -> Dict[str, Any]:
    """The WHOLE stored row, the two marker columns aside."""
    return dict((k, v) for k, v in row.items() if k not in STALE_COLUMNS)


def _is_a_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _strings_in(row: Dict[str, Any]) -> List[str]:
    return [v for v in row.values() if isinstance(v, str)]


def _world(*, stored_body: Optional[str] = GOOD_BODY,
           stored_stale: Tuple[Optional[str], Optional[str]] = (None, None),
           stored_definition: str = CURRENT_DEFINITION,
           recommendations: bool = True, period: bool = True,
           stale_migration_applied: bool = True) -> RecordingDouble:
    """One analysed period of ORG — its briefing (`stored_body`; None = no
    row, a first analysis), two recommendations a user has worked on, one
    alert of the previous run — beside another tenant's period.
    `period=False`: the period row and everything under it are gone (what a
    concurrent DELETE /api/period leaves)."""
    double = RecordingDouble(stale_migration_applied=stale_migration_applied)
    if period:
        double.add("financial_periods", {"id": PID, "org_id": ORG, "currency": "RON",
                                         "period_start": "2025-01-01", "period_end": "2025-12-31"})
    double.add("financial_periods", {"id": OTHER_PID, "org_id": OTHER_ORG, "currency": "RON",
                                     "period_start": "2025-01-01", "period_end": "2025-12-31"})
    if period and stored_body is not None:
        row = {"id": "briefing-of-the-period", "period_id": PID, "org_id": ORG, "body": stored_body,
               "language": "ro", "model": "the-model-of-the-stored-write",
               "created_at": "2026-09-01T09:00:00+00:00",
               "ebitda_definition": stored_definition}
        if stale_migration_applied:
            row.update(stale_since=stored_stale[0], stale_reason=stored_stale[1])
        double.add("briefings", row)
    double.add("briefings", {"id": "briefing-of-the-other-tenant", "period_id": OTHER_PID,
                             "org_id": OTHER_ORG, "body": "The other tenant's briefing.",
                             "language": "en", "model": "the-model-of-the-stored-write"})
    if period and recommendations:
        double.add("recommendations", {
            "id": "rec-1", "org_id": ORG, "period_id": PID, "target_type": "dataset", "target_id": PID,
            "title": "Renegociază termenele de plată cu furnizorii",
            "explanation": "Furnizorii sunt plătiți mai repede decât încasează compania.",
            "urgency": "high", "status": "in_progress", "owner": "CFO", "due_date": "2026-11-15"})
        double.add("recommendations", {
            "id": "rec-2", "org_id": ORG, "period_id": PID, "target_type": "dataset", "target_id": PID,
            "title": "Redu stocul de materii prime", "explanation": "Stocul acoperă prea multe zile.",
            "urgency": "medium", "status": "new"})
    double.add("recommendations", {
        "id": "rec-of-the-other-tenant", "org_id": OTHER_ORG, "period_id": OTHER_PID,
        "target_type": "dataset", "target_id": OTHER_PID, "title": "Theirs", "explanation": "Theirs.",
        "urgency": "low", "status": "new"})
    if period:
        double.add("alerts", {"id": "alert-of-the-previous-run", "org_id": ORG, "period_id": PID,
                              "alert_key": OLD_ALERT_KEY, "severity": "low", "category": "data_quality",
                              "title": "Old", "body": "Old.", "document_id": DOC_ID})
    # The same alert_key as one of the run's, under ANOTHER period.
    double.add("alerts", {"id": "alert-of-the-other-tenant", "org_id": OTHER_ORG, "period_id": OTHER_PID,
                          "alert_key": "liquidity_cash_ratio_low", "severity": "high",
                          "category": "liquidity", "title": "Theirs", "body": "Theirs.",
                          "document_id": "doc-of-the-other-tenant"})
    return double


def _persist(double: RecordingDouble, narration: Dict[str, Any], *,
             language: Optional[str] = "ro") -> None:
    """The REAL `stage_persist_narrative`, the database doubled."""
    with RA.installed(double):
        P.stage_persist_narrative(_doc(language), PID, narration, copy.deepcopy(RUN_ALERTS))


def _assert_the_runs_alerts_are_stored(double: RecordingDouble, what: str) -> None:
    mine = _of_period(double, "alerts")
    assert sorted(a["alert_key"] for a in mine) == RUN_ALERT_KEYS, (
        "%s: the run's deterministic alerts were not written (stored: %r)"
        % (what, sorted(a["alert_key"] for a in mine)))
    for a in mine:
        assert a["org_id"] == ORG and a["document_id"] == DOC_ID, a


# ══════════════════════════════════════════════════════════════════════
# W1 — a failed narration over a usable briefing
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("branch", ALL_FAILURES)
def test_a_failed_narration_over_a_usable_briefing_keeps_the_row_and_the_recommendations(monkeypatch, branch):
    """Measured before the repair: the briefing became the failure text and
    both recommendations were deleted."""
    narration, _code = _failed_narration(monkeypatch, branch)
    double = _world()
    briefings_before = copy.deepcopy(double.rows("briefings"))
    recommendations_before = copy.deepcopy(double.rows("recommendations"))
    foreign_before = _foreign(double)

    _persist(double, narration)

    # THE WHOLE TABLE, row for row — the marker columns aside.
    assert [_sans_marker(r) for r in double.rows("briefings")] == \
        [_sans_marker(r) for r in briefings_before], \
        "%s: the stored briefing changed — the last good one is gone" % branch
    assert [r["body"] for r in _of_period(double, "briefings")] == [GOOD_BODY]
    assert double.rows("recommendations") == recommendations_before, \
        "%s: the period's recommendations were not kept exactly" % branch
    # …and by the writes themselves: nothing was upserted or deleted on the
    # briefing, nothing at all touched the recommendations.
    assert _writes(double, "briefings", "upsert") == [], _writes(double, "briefings", "upsert")
    assert _writes(double, "briefings", "delete") == []
    assert _writes(double, "recommendations") == [], _writes(double, "recommendations")
    # The alerts are deterministic: written in every case, and only this
    # period's are replaced.
    _assert_the_runs_alerts_are_stored(double, branch)
    assert OLD_ALERT_KEY not in [a["alert_key"] for a in double.rows("alerts")]
    assert _foreign(double) == foreign_before, "%s: another tenant's rows changed" % branch
    # The stored row was READ with the tenant in the filter: the read runs
    # under the service role, so the filter is the access control.
    reads = double.selects("briefings")
    assert reads, "%s: the writer never read the stored briefing" % branch
    for _op, _table, filters, _columns in reads:
        assert filters == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, \
            "%s: the stored briefing was read without the tenant in the filter: %r" % (branch, filters)


@pytest.mark.parametrize("branch", ALL_FAILURES)
def test_the_kept_briefing_is_marked_stale_by_a_separate_update_filtered_by_period_and_tenant(monkeypatch, branch):
    narration, code = _failed_narration(monkeypatch, branch)
    double = _world()

    _persist(double, narration)

    updates = _writes(double, "briefings", "update")
    assert len(updates) == 1, "%s: expected ONE marker update on briefings, got %r" % (branch, updates)
    (marker,) = updates
    assert marker["filters"] == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, \
        "%s: the marker update must be filtered by period_id AND org_id: %r" % (branch, marker["filters"])
    assert sorted(marker["payload"]) == ["stale_reason", "stale_since"], marker["payload"]
    assert marker["refused"] is False
    (row,) = _of_period(double, "briefings")
    if code is not None:
        assert row["stale_reason"] == code, (branch, row["stale_reason"])
    assert row["stale_reason"] in NEUTRAL_CODES, \
        "%s: stale_reason must be a neutral code, got %r" % (branch, row["stale_reason"])
    assert _is_a_timestamp(row["stale_since"]), row["stale_since"]
    # Never provider text, anywhere in the row.
    for value in _strings_in(row):
        assert "credit balance" not in value and "Error code" not in value, row
    # The marker is this row's alone, and it never rode an upsert.
    (theirs,) = _of_period(double, "briefings", OTHER_PID)
    assert theirs["stale_since"] is None and theirs["stale_reason"] is None
    assert _writes(double, "briefings", "upsert") == []


def test_a_second_failure_keeps_the_first_stale_since_and_carries_the_new_reason(monkeypatch):
    """supabase/schema_phase_briefing_stale.sql: `stale_since` is "when the
    FIRST narration since the last good write failed"."""
    narration, code = _real_failed_narration(monkeypatch, "reply_is_not_json")
    assert code == "unparseable_reply"
    double = _world(stored_stale=("2026-09-30T08:00:00+00:00", "provider_error"))
    before = copy.deepcopy(_of_period(double, "briefings"))

    _persist(double, narration)

    (marker,) = _writes(double, "briefings", "update")
    assert "stale_since" not in marker["payload"], \
        "the second failure rewrote stale_since: %r" % (marker["payload"],)
    (row,) = _of_period(double, "briefings")
    assert row["stale_since"] == "2026-09-30T08:00:00+00:00", "the first failure's time was moved"
    assert row["stale_reason"] == "unparseable_reply"
    assert _sans_marker(row) == _sans_marker(before[0])


# ══════════════════════════════════════════════════════════════════════
# W2 / W8 — a failed narration with nothing to protect
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("branch", sorted(REAL_FAILURES))
def test_a_failed_first_analysis_stores_exactly_the_neutral_sentinel(monkeypatch, branch):
    """Measured before the repair: with no API key the stored body was "Set
    ANTHROPIC_API_KEY on the backend to enable AI narrative."; an unparseable
    reply stored its first 500 characters."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _world(stored_body=None, recommendations=False)
    assert _of_period(double, "briefings") == []

    _persist(double, narration)

    rows = _of_period(double, "briefings")
    assert len(rows) == 1, rows
    (row,) = rows
    assert row["body"] == "[NARRATIVE_UNAVAILABLE]", \
        "%s: a first analysis stored %r" % (branch, row["body"])
    assert row["org_id"] == ORG
    returned = narration.get("briefing")
    for value in _strings_in(row):
        for fragment in FORBIDDEN_IN_A_STORED_ROW:
            assert fragment not in value, "%s: the stored row carries %r: %r" % (branch, fragment, row)
        if returned != SENTINEL:
            assert returned not in value, "%s: the branch's own text was stored" % branch
        if narration.get("narrate_error"):
            assert narration["narrate_error"] not in value


@pytest.mark.parametrize("branch", sorted(REAL_FAILURES))
def test_every_failure_result_of_the_real_narrator_can_be_persisted_as_a_first_analysis(monkeypatch, branch):
    """The writer reads `briefing` and `recommendations` off the result: a
    failure branch that returned neither would raise here, and the
    orchestrator would swallow it (non-fatal) — no briefing row, no alerts."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    assert "briefing" in narration and isinstance(narration.get("recommendations"), list), narration
    double = _world(stored_body=None, recommendations=False)

    _persist(double, narration)  # must not raise

    # It ran to its LAST step: the alerts are there, and nothing was invented.
    _assert_the_runs_alerts_are_stored(double, branch)
    assert _of_period(double, "recommendations") == []
    assert len(_of_period(double, "briefings")) == 1


# ══════════════════════════════════════════════════════════════════════
# W3 — a failed narration over a stored failure text
# ══════════════════════════════════════════════════════════════════════

#: What rows written before the repair can hold (SPEC D5, the text predicate).
STORED_FAILURE_TEXTS = {
    "the_sentinel": "[NARRATIVE_UNAVAILABLE]",
    "provider_text_of_before_2026_08_04": "Narrative unavailable: " + PROVIDER_ERROR_TEXT,
    "the_operator_sentence_for_a_missing_key": "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.",
    "the_operator_sentence_for_a_missing_sdk": "anthropic SDK not installed on backend.",
    "the_empty_reply_fallback": "Narrative unavailable.",
    "the_numeral_guard_sentence": ("The briefing was withheld: the model cited figures the engine did "
                                   "not author. The statements, ratios and alerts on this page are "
                                   "unaffected and remain engine-computed."),
    "an_empty_body": "",
}


@pytest.mark.parametrize("branch", ["provider_raises", "no_api_key"])
@pytest.mark.parametrize("stored", sorted(STORED_FAILURE_TEXTS))
def test_a_failed_narration_over_a_stored_failure_text_stores_the_sentinel_and_does_not_raise(
        monkeypatch, stored, branch):
    """The BRIEFING half of W3. The world holds the period's two worked
    recommendations as well (the state the pre-repair regenerate left in
    production: the sentinel over the briefing, the recommendations
    untouched) — what happens to THEM is the test below."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _world(stored_body=STORED_FAILURE_TEXTS[stored])
    foreign_before = _foreign(double)

    _persist(double, narration)  # must not raise

    rows = _of_period(double, "briefings")
    assert len(rows) == 1, rows
    assert rows[0]["body"] == "[NARRATIVE_UNAVAILABLE]", \
        "stored %s + %s: the row holds %r" % (stored, branch, rows[0]["body"])
    for value in _strings_in(rows[0]):
        for fragment in FORBIDDEN_IN_A_STORED_ROW:
            assert fragment not in value, (stored, branch, rows[0])
    _assert_the_runs_alerts_are_stored(double, stored)
    assert _foreign(double) == foreign_before


#: The stored briefing states in which a failed narration finds NOTHING
#: usable to keep — and the period still holds its recommendations.
_NOTHING_USABLE_STORED = dict(STORED_FAILURE_TEXTS, no_briefing_row_at_all=None)


@pytest.mark.parametrize("branch", ["provider_raises", "no_api_key"])
@pytest.mark.parametrize("stored", sorted(_NOTHING_USABLE_STORED))
def test_a_failed_narration_never_deletes_the_periods_recommendations_whatever_the_briefing_row_holds(
        monkeypatch, stored, branch):
    """RULED 2026-10-03: a failed narration NEVER deletes the period's
    recommendations, whatever the stored briefing row holds. (Measured on
    d3c955a7: recommendations 2 -> 0 in all 16 cases.)

    The gate sentence (SPEC, "Gates"): "a failed re-run narration keeps the
    briefing and the recommendations" — unconditional. D6b names the
    protection only for "a usable stored row", and the writer followed D6b
    to the letter: it kept the recommendations only when it kept the
    briefing, and otherwise ran `delete("recommendations", period_id=…)`
    and re-inserted the failed narration's empty list.

    This is the production state: the pre-repair regenerate wrote the
    sentinel over the briefing and never touched the recommendations, so
    the first re-run whose narration failed wiped the statuses, owners and
    due dates a user had set on them — because a model call failed.

    The usable-row case is W1 above; the positive control — a narration
    that WORKED replaces the recommendations — is W4 below."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _world(stored_body=_NOTHING_USABLE_STORED[stored])
    before = copy.deepcopy(_of_period(double, "recommendations"))
    assert [r["id"] for r in before] == ["rec-1", "rec-2"] and before[0]["status"] == "in_progress", before
    foreign_before = _foreign(double)

    _persist(double, narration)  # must not raise

    after = _of_period(double, "recommendations")
    assert after == before, (
        "stored briefing %s + narration %s: a FAILED narration cost the period its recommendations "
        "(%d before, %d after) — the user's statuses, owners and due dates went with them"
        % (stored, branch, len(before), len(after)))
    # …and by the writes themselves: not deleted and re-inserted alike —
    # nothing at all touched the table.
    assert _writes(double, "recommendations") == [], _writes(double, "recommendations")
    _assert_the_runs_alerts_are_stored(double, stored)
    assert _foreign(double) == foreign_before


# ══════════════════════════════════════════════════════════════════════
# W4 — POSITIVE CONTROL: a usable narration is written
# ══════════════════════════════════════════════════════════════════════


def test_a_usable_narration_is_written_with_its_language_model_and_definition_and_clears_the_marker(monkeypatch):
    """Beside "nothing is written on a failure": a narration that worked
    REPLACES the stored briefing — here one that had been kept, stale."""
    monkeypatch.setattr(P, "_NARRATIVE_MODEL", "narrative-model-of-this-test", raising=False)
    narration, _requests = _real_usable_narration(monkeypatch, language="ro")
    # The stored row was written under the PREVIOUS EBITDA definition: the
    # stamp asserted below can only come from this write.
    double = _world(stored_stale=("2026-09-30T08:00:00+00:00", "provider_error"),
                    stored_definition=PREVIOUS_DEFINITION)
    assert _of_period(double, "briefings")[0]["ebitda_definition"] == \
        "ebitda/2026-09-26:711-72x-inside,767-financial"
    foreign_before = _foreign(double)

    _persist(double, narration, language="ro")

    rows = _of_period(double, "briefings")
    assert len(rows) == 1, rows
    (row,) = rows
    assert row["body"] == NEW_BODY, "a usable narration was not written: %r" % row["body"]
    assert row["language"] == "ro", "Romanian prose stamped %r" % row["language"]
    assert row["model"] == "narrative-model-of-this-test", row["model"]
    assert row["ebitda_definition"] == (
        "ebitda/2026-09-28:711-72x-inside,767-financial,"
        "provisions-6812-6814-7812-7814-outside,7411-turnover"), \
        "the briefing was not stamped with today's EBITDA definition: %r" % row["ebitda_definition"]
    assert row["org_id"] == ORG
    # The marker: cleared — by a SEPARATE update, the tenant in its filter,
    # never by the upsert.
    assert row["stale_since"] is None and row["stale_reason"] is None, row
    (upsert,) = _writes(double, "briefings", "upsert")
    assert upsert["on_conflict"] == "period_id"
    assert not set(upsert["payload"]) & set(STALE_COLUMNS), upsert["payload"]
    (clear,) = _writes(double, "briefings", "update")
    assert clear["payload"] == {"stale_since": None, "stale_reason": None}, clear["payload"]
    assert clear["filters"] == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, clear["filters"]
    assert _foreign(double) == foreign_before


def test_a_usable_narration_replaces_the_periods_recommendations_with_the_runs(monkeypatch):
    narration, _requests = _real_usable_narration(monkeypatch)
    double = _world()
    foreign_before = _foreign(double)

    _persist(double, narration)

    recs = _of_period(double, "recommendations")
    assert [(r["title"], r["urgency"], r["status"], r["org_id"], r["target_id"]) for r in recs] == \
        [("Scurtează termenele de încasare", "high", "new", ORG, PID)], recs
    # The whole text column, written out: the rationale, then the actions.
    assert recs[0]["explanation"] == (
        "Creanțele se încasează mai lent decât se plătesc furnizorii."
        "\n\nActions:\n• Revizuiește termenele contractuale\n• Urmărește săptămânal restanțele"), \
        recs[0]["explanation"]
    assert recs[0]["expected_cash_impact_kron"] is None
    # The superseded ones went by ONE delete, the tenant in its filter (it
    # runs under the service role).
    (delete,) = _writes(double, "recommendations", "delete")
    assert delete["filters"] == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, delete["filters"]
    _assert_the_runs_alerts_are_stored(double, "usable")
    assert _foreign(double) == foreign_before


def test_a_usable_narration_that_recommends_nothing_replaces_the_stored_recommendations_with_none(monkeypatch):
    """POSITIVE CONTROL of "unreadable recommendations replace nothing"
    (below): an EMPTY list is readable — the narration recommends nothing,
    and that replaces what the period held."""
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    _install_provider(monkeypatch, lambda _kw: _Reply(json.dumps(
        {"briefing": NEW_BODY, "recommendations": []}, ensure_ascii=False)))
    narration = _narrate("ro")
    assert narration.get("briefing") == NEW_BODY and narration.get("recommendations") == [] \
        and not narration.get("unavailable"), narration
    double = _world()
    foreign_before = _foreign(double)

    _persist(double, narration)

    assert _of_period(double, "recommendations") == [], _of_period(double, "recommendations")
    assert [r["body"] for r in _of_period(double, "briefings")] == [NEW_BODY]
    _assert_the_runs_alerts_are_stored(double, "an empty list")
    assert _foreign(double) == foreign_before


@pytest.mark.parametrize("detected,instruction,stamp", [
    ("ro", "Răspunde în limba română.", "ro"),
    ("RO", "Răspunde în limba română.", "ro"),
    ("en", "Reply in English.", "en"),
    (None, "Reply in English.", "en"),
    # German prose: the column's check constraint allows only en / ro.
    ("de", "Antworten Sie auf Deutsch.", "en"),
], ids=["ro", "RO_in_capitals", "en", "no_language_on_the_document", "de_clamped_to_en"])
def test_the_language_stamp_is_the_language_the_narrator_was_told_to_write_in(
        monkeypatch, detected, instruction, stamp):
    """SPEC D9: "`stage_persist_narrative` stamps the true language too"
    (clamped to 'en' / 'ro'). Every write stamped 'en' before."""
    narration, requests = _real_usable_narration(monkeypatch, language=detected)
    (request,) = requests
    assert instruction in request["system"], "the narrator was not told %r" % instruction
    double = _world(stored_body=None, recommendations=False)

    _persist(double, narration, language=detected)

    (row,) = _of_period(double, "briefings")
    assert row["body"] == NEW_BODY
    assert row["language"] == stamp, "narrated under %r, stamped %r" % (instruction, row["language"])
    # A FIRST write (no stored row to merge into): the definition stamp on
    # the row is the payload's own.
    assert row["ebitda_definition"] == CURRENT_DEFINITION, row["ebitda_definition"]


def test_the_definition_stated_in_this_file_is_the_packs_current_revision():
    """A side check, not the law: the stamp is asserted above against
    literals. When the EBITDA definition is revised, UPDATE
    `CURRENT_DEFINITION` / `PREVIOUS_DEFINITION` in this file — do not make
    the assertions read the engine's constant."""
    assert CURRENT_DEFINITION == EBITDA_DEFINITION_REVISION, (
        "the EBITDA definition was revised to %r: update CURRENT_DEFINITION (and move the old "
        "value to PREVIOUS_DEFINITION) in this file" % (EBITDA_DEFINITION_REVISION,))
    assert PREVIOUS_DEFINITION != CURRENT_DEFINITION


def test_a_usable_narration_over_a_stored_failure_text_replaces_it_and_the_recommendations(monkeypatch):
    """THE RECOVERY CELL at the direct seam: the period holds the sentinel
    (a failed first analysis, or the pre-repair regenerate), and the
    narration WORKS — the failure text goes, the run's body and
    recommendations are written, no marker is left."""
    narration, _requests = _real_usable_narration(monkeypatch)
    double = _world(stored_body="[NARRATIVE_UNAVAILABLE]",
                    stored_stale=("2026-09-30T08:00:00+00:00", "provider_error"))
    foreign_before = _foreign(double)

    _persist(double, narration)

    (row,) = _of_period(double, "briefings")
    assert row["body"] == NEW_BODY, "the stored failure text survived a usable narration: %r" % row["body"]
    assert row["stale_since"] is None and row["stale_reason"] is None, row
    assert [r["title"] for r in _of_period(double, "recommendations")] == ["Scurtează termenele de încasare"]
    _assert_the_runs_alerts_are_stored(double, "recovery")
    assert _foreign(double) == foreign_before


# ══════════════════════════════════════════════════════════════════════
# W5 — the marker columns and the migration
# ══════════════════════════════════════════════════════════════════════


def test_no_briefing_upsert_of_the_writer_carries_a_marker_column(monkeypatch):
    """An upsert naming a column PostgREST does not know is rejected whole:
    with the marker inside the payload every briefing write would depend on
    the migration (SPEC D7)."""
    usable, _requests = _real_usable_narration(monkeypatch)
    failed, _code = _real_failed_narration(monkeypatch, "provider_raises")
    payloads = []  # type: List[Dict[str, Any]]
    scenarios = (
        ("a usable narration over a stale briefing", usable,
         dict(stored_stale=("2026-09-30T08:00:00+00:00", "provider_error"))),
        ("a usable first narration", usable, dict(stored_body=None, recommendations=False)),
        ("a failed first narration", failed, dict(stored_body=None, recommendations=False)),
        ("a failed narration over a failure text", failed, dict(stored_body=SENTINEL, recommendations=False)),
        ("a failed narration over a usable briefing", failed, dict()),
    )
    for what, narration, world in scenarios:
        double = _world(**world)
        _persist(double, copy.deepcopy(narration))
        for upsert in _writes(double, "briefings", "upsert"):
            assert isinstance(upsert["payload"], dict), (what, upsert)
            payloads.append(upsert["payload"])
            assert not set(upsert["payload"]) & set(STALE_COLUMNS), \
                "%s: the briefing upsert names a marker column: %r" % (what, sorted(upsert["payload"]))
    # The subject's own floor: four of the five scenarios upsert a briefing.
    assert len(payloads) == 4, "expected four briefing upserts, examined %d" % len(payloads)


def test_every_briefings_upsert_in_the_engine_is_a_literal_payload_without_a_marker_column():
    """The census: every `.upsert("briefings", {...})` under src/engine."""
    sites = []  # type: List[Tuple[str, int, Any]]
    for path in sorted((REPO / "src" / "engine").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if '"briefings"' not in text and "'briefings'" not in text:
            continue
        for node in ast.walk(ast.parse(text)):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "upsert" and node.args
                    and isinstance(node.args[0], ast.Constant) and node.args[0].value == "briefings"):
                sites.append((str(path.relative_to(REPO)), node.lineno,
                              node.args[1] if len(node.args) > 1 else None))
    # Two writers upsert a briefing: stage_persist_narrative and the
    # regenerate route. Finding fewer means this census reads nothing.
    assert len(sites) >= 2, "the census found %d briefings upsert(s): %r" % (
        len(sites), [(p, n) for p, n, _ in sites])
    for path, line, payload in sites:
        where = "%s:%d" % (path, line)
        assert isinstance(payload, ast.Dict), "%s: the payload is not a dict literal — cannot be read" % where
        keys = [k.value if isinstance(k, ast.Constant) else None for k in payload.keys]
        assert None not in keys, "%s: a computed or unpacked key — cannot be read" % where
        assert not set(keys) & set(STALE_COLUMNS), \
            "%s: the briefing upsert names a marker column: %r" % (where, keys)
        assert "body" in keys and "period_id" in keys and "org_id" in keys, (where, keys)


def test_the_stale_migration_declares_the_two_marker_columns():
    """Without them the "applied" double IS the unapplied one, and the
    marker laws above would be about nothing."""
    assert set(STALE_COLUMNS) <= set(RA.migration_columns()["briefings"])
    assert not set(STALE_COLUMNS) & set(RecordingDouble(stale_migration_applied=False).columns["briefings"])


def _unapplied(**world: Any) -> RecordingDouble:
    """`briefings` before the migration — and the proof that this double
    refuses the marker exactly as PostgREST would."""
    double = _world(stale_migration_applied=False, **world)
    with pytest.raises(httpx.HTTPStatusError):
        double.update("briefings", {"stale_reason": "provider_error"},
                      filters={"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG})
    double.writes[:] = []
    return double


def test_with_the_stale_migration_not_applied_a_failed_narration_still_keeps_everything_and_writes_the_alerts(
        monkeypatch):
    narration, _code = _real_failed_narration(monkeypatch, "provider_raises")
    double = _unapplied()
    briefings_before = copy.deepcopy(double.rows("briefings"))
    recommendations_before = copy.deepcopy(double.rows("recommendations"))

    _persist(double, narration)  # must not raise

    assert double.rows("briefings") == briefings_before, "the stored briefing changed"
    assert double.rows("recommendations") == recommendations_before
    _assert_the_runs_alerts_are_stored(double, "unapplied")
    # The marker WAS attempted — separately, the tenant in its filter — and
    # refused; nothing else on the briefing was attempted.
    (attempt,) = _writes(double, "briefings")
    assert attempt["op"] == "update" and attempt["refused"] is True, attempt
    assert attempt["filters"] == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}


def test_with_the_stale_migration_not_applied_a_usable_narration_and_a_first_failure_are_still_written(
        monkeypatch):
    usable, _requests = _real_usable_narration(monkeypatch)
    double = _unapplied()
    _persist(double, usable)  # must not raise
    (row,) = _of_period(double, "briefings")
    assert row["body"] == NEW_BODY, "a usable narration was not written before the migration"
    assert [r["title"] for r in _of_period(double, "recommendations")] == [NEW_RECOMMENDATION]
    _assert_the_runs_alerts_are_stored(double, "unapplied, usable")
    (refused,) = _writes(double, "briefings", "update")
    assert refused["refused"] is True and not _writes(double, "briefings", "upsert")[0]["refused"]

    failed, _code = _real_failed_narration(monkeypatch, "no_api_key")
    first = _unapplied(stored_body=None, recommendations=False)
    _persist(first, failed)  # must not raise
    (row,) = _of_period(first, "briefings")
    assert row["body"] == "[NARRATIVE_UNAVAILABLE]", row["body"]
    _assert_the_runs_alerts_are_stored(first, "unapplied, first failure")


# ══════════════════════════════════════════════════════════════════════
# W9 — the period vanished mid-run
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("kind", ["a_usable_narration", "a_failed_narration"])
def test_a_period_that_vanished_mid_run_gets_no_write_and_no_raise(monkeypatch, kind):
    if kind == "a_usable_narration":
        narration, _requests = _real_usable_narration(monkeypatch)
    else:
        narration, _code = _real_failed_narration(monkeypatch, "provider_raises")
    # POSITIVE CONTROL: with the period there, the very same call writes.
    there = _world(stored_body=None, recommendations=False)
    _persist(there, copy.deepcopy(narration))
    assert _writes(there, "briefings", "upsert") and _writes(there, "alerts"), there.writes

    gone = _world(period=False)
    before = copy.deepcopy(dict((t, rows) for t, rows in gone.tables.items() if rows))
    _persist(gone, copy.deepcopy(narration))  # must not raise
    assert gone.writes == [], "a write for a period that no longer exists: %r" % gone.writes
    assert dict((t, rows) for t, rows in gone.tables.items() if rows) == before


# ══════════════════════════════════════════════════════════════════════
# The writer must REACH its alerts — two shapes that make it raise mid-way
# ══════════════════════════════════════════════════════════════════════
#
# `stage_persist_narrative` writes in this order: the briefing, the delete
# of the period's recommendations, their re-insert, the alerts. A raise
# while it builds the recommendation rows therefore lands AFTER the
# destructive writes and BEFORE the alerts — and the orchestrator swallows
# it as non-fatal: the document ends `analyzed`, with the recommendations
# gone and the alerts of the previous run still in place.

#: `stage_narrate` hands any truthy `recommendations` on
#: (`data.get("recommendations", []) or []`) with NO `unavailable` code.
_MALFORMED_RECOMMENDATIONS = {
    "a_null_rationale": [{"severity": "high", "title": "A", "rationale": None, "actions": ["x"]}],
    "actions_that_are_numbers": [{"severity": "high", "title": "A", "rationale": "Because.",
                                  "actions": [1, 2]}],
    "a_string": "none",
    "a_list_holding_null": [None],
    "an_object": {"items": []},
    # One object among the debris: the object is stored, the rest dropped.
    "an_object_among_debris": [None, "text", {"severity": 7, "title": None, "rationale": "Because.",
                                              "actions": "Do it", "estimated_ron_impact": "unknown"}],
}  # type: Dict[str, Any]

#: WHAT THE PERIOD'S RECOMMENDATIONS HOLD AFTERWARDS (W11) — stated here,
#: (title, explanation, urgency, expected_cash_impact_kron) per stored row;
#: None = unreadable: the two stored recommendations are kept exactly and
#: nothing touches the table.
_AFTER_MALFORMED_RECOMMENDATIONS = {
    "a_null_rationale": [("A", "\n\nActions:\n• x", "high", None)],
    "actions_that_are_numbers": [("A", "Because.\n\nActions:\n• 1\n• 2", "high", None)],
    "a_string": None,
    "a_list_holding_null": None,
    "an_object": None,
    "an_object_among_debris": [("Untitled recommendation", "Because.\n\nActions:\n• Do it", "medium", None)],
}  # type: Dict[str, Optional[List[Tuple[str, str, str, Any]]]]


def _persist_catching(double: RecordingDouble, narration: Any) -> Optional[BaseException]:
    """The real writer; what it raised (None when it ran to its end)."""
    try:
        _persist(double, narration)
    except Exception as exc:  # noqa: BLE001 — the raise IS the measurement
        return exc
    return None


@pytest.mark.parametrize("shape", sorted(_MALFORMED_RECOMMENDATIONS))
def test_a_usable_briefing_with_malformed_recommendations_does_not_raise_and_the_alerts_are_written(
        monkeypatch, shape):
    """`stage_persist_narrative`'s own contract: "Alerts are deterministic
    and are written in every case." A reply whose `recommendations` is not
    the list of objects asked for is handed on by the real `stage_narrate`
    as a USABLE narration. Measured on d3c955a7: the writer replaced the
    briefing, deleted the period's recommendations and raised (TypeError /
    AttributeError) while it built the rows — the run's alerts were never
    written, and through the pipeline nobody heard of it.

    RULED 2026-10-03: "malformed recommendation items are validated BEFORE
    any destructive write; alerts are written in every case." Asserted: no
    raise; the run's alerts stored; the usable briefing written; and the
    period's recommendations (W11, decided by the repair):
      · an OBJECT item is stored, its fields coerced to what the columns
        hold (a null rationale is the empty text, numeric actions their
        text, a title that is not text the default, an unparseable cash
        impact null); anything in the list that is not an object is dropped;
      · a `recommendations` that cannot be read at all — a string, an
        object, a list holding no object — replaces NOTHING: the stored
        recommendations are kept exactly, and no write touches the table."""
    reply = {"briefing": NEW_BODY, "recommendations": _MALFORMED_RECOMMENDATIONS[shape]}
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    _install_provider(monkeypatch, lambda _kw: _Reply(json.dumps(reply, ensure_ascii=False)))
    narration = _narrate("ro")
    # PRECONDITION: the real narrator calls this a narration that worked.
    assert narration.get("briefing") == NEW_BODY and not narration.get("unavailable"), (
        "PRECONDITION: stage_narrate must hand %s on as usable: %r" % (shape, narration))
    double = _world()
    recommendations_before = copy.deepcopy(_of_period(double, "recommendations"))
    assert len(recommendations_before) == 2
    foreign_before = _foreign(double)

    raised = _persist_catching(double, narration)

    stored = sorted(a["alert_key"] for a in _of_period(double, "alerts"))
    assert raised is None and stored == RUN_ALERT_KEYS, (
        "recommendations = %s: the writer raised %r after its destructive writes; the alerts stored "
        "are %r (the run's are %r) and the period holds %d recommendation(s)"
        % (shape, raised, stored, RUN_ALERT_KEYS, len(_of_period(double, "recommendations"))))
    # The briefing of a narration that WORKED is written whatever its
    # recommendations look like.
    assert [r["body"] for r in _of_period(double, "briefings")] == [NEW_BODY]
    expected = _AFTER_MALFORMED_RECOMMENDATIONS[shape]
    after = _of_period(double, "recommendations")
    if expected is None:
        assert after == recommendations_before, (
            "recommendations = %s (unreadable): the period's stored recommendations were not kept "
            "exactly (%d before, %d after)" % (shape, len(recommendations_before), len(after)))
        assert _writes(double, "recommendations") == [], _writes(double, "recommendations")
    else:
        assert [(r["title"], r["explanation"], r["urgency"], r["expected_cash_impact_kron"])
                for r in after] == expected, (shape, after)
        assert all(r["org_id"] == ORG and r["period_id"] == PID and r["status"] == "new" for r in after)
    assert _foreign(double) == foreign_before


@pytest.mark.parametrize("written,stored", [
    (12000, 12000), (12000.5, 12000.5), (-3500, -3500), (0, 0), ("12000", 12000.0),
    # Never guessed at: a thousands separator, a decimal comma, a sentence,
    # a boolean, not-a-number, nothing.
    ("12,500", None), ("1.234,56", None), ("about 12k", None), (True, None),
    (float("nan"), None), (float("inf"), None), (None, None), ([12000], None),
], ids=["an_integer", "a_float", "a_negative", "zero", "a_plain_numeric_string",
        "a_thousands_separator", "a_decimal_comma", "a_sentence", "a_boolean",
        "not_a_number", "infinity", "null", "a_list"])
def test_a_recommendations_cash_impact_is_a_number_or_absent_never_a_guess(written, stored):
    """`expected_cash_impact_kron` is a numeric column: what a model wrote
    there is stored as the number it is, or as nothing — a value PostgREST
    would refuse used to raise AFTER the period's recommendations had been
    deleted, and a guess at "1.234,56" would be a figure nobody authored."""
    rows = P._recommendation_rows(
        {"briefing": NEW_BODY, "recommendations": [
            {"severity": "low", "title": "T", "rationale": "R", "actions": [],
             "estimated_ron_impact": written}]}, ORG, PID)
    assert rows is not None and len(rows) == 1, rows
    got = rows[0]["expected_cash_impact_kron"]
    assert got == stored and type(got) is type(stored), (written, got)
    assert (rows[0]["title"], rows[0]["explanation"], rows[0]["urgency"], rows[0]["status"],
            rows[0]["org_id"], rows[0]["period_id"], rows[0]["target_type"], rows[0]["target_id"]) == \
        ("T", "R", "low", "new", ORG, PID, "dataset", PID)


def test_the_takeover_is_told_when_a_usable_narrations_recommendations_cannot_be_read(monkeypatch):
    """`narration_recommendations_unreadable` is what the orchestrator hands
    the same-month takeover (`keep_recommendations`): true ONLY for a usable
    narration whose list cannot be read — never for a failed narration (the
    takeover decides that on the briefing), never for a readable list, an
    empty one included."""
    usable, _requests = _real_usable_narration(monkeypatch)
    failed, _code = _real_failed_narration(monkeypatch, "provider_raises")
    cases = [
        (usable, False),
        (dict(usable, recommendations=[]), False),
        (dict(usable, recommendations=[{"title": "A", "rationale": None}]), False),
        (dict(usable, recommendations="none"), True),
        (dict(usable, recommendations=[None]), True),
        (dict(usable, recommendations={"items": []}), True),
        (failed, False),
        (None, False),
    ]
    assert [P.narration_recommendations_unreadable(n) for n, _ in cases] == [e for _, e in cases]


# ══════════════════════════════════════════════════════════════════════
# W10 — the alerts are written even when a narrative write RAISES
# ══════════════════════════════════════════════════════════════════════


class _RefusingDouble(RecordingDouble):
    """`RecordingDouble` whose database times out on chosen writes — (op,
    table) pairs — exactly as a transient PostgREST failure does."""

    def __init__(self, refuse: Tuple[Tuple[str, str], ...], **kwargs: Any) -> None:
        super(_RefusingDouble, self).__init__(**kwargs)
        self.refuse = set(refuse)

    def _maybe_refuse(self, op: str, table: str) -> None:
        if (op, table) in self.refuse:
            self.writes.append({"op": op, "table": table, "payload": None, "filters": {},
                                "on_conflict": None, "refused": True})
            raise httpx.ReadTimeout("The read operation timed out")

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        self._maybe_refuse("insert", table)
        return super(_RefusingDouble, self).insert(table, rows, returning=returning)

    def upsert(self, table: str, rows: Any, *, on_conflict: Optional[str] = None,
               returning: bool = True) -> List[Dict[str, Any]]:
        self._maybe_refuse("upsert", table)
        return super(_RefusingDouble, self).upsert(table, rows, on_conflict=on_conflict, returning=returning)


def _seed_like(world: RecordingDouble, refusing: _RefusingDouble) -> _RefusingDouble:
    for table, rows in world.tables.items():
        for row in rows:
            refusing.add(table, copy.deepcopy(row))
    refusing.writes[:] = []
    return refusing


@pytest.mark.parametrize("refused,narration_kind", [
    (("upsert", "briefings"), "usable"),
    (("upsert", "briefings"), "failed"),
    (("insert", "recommendations"), "usable"),
], ids=["the_briefing_write_of_a_usable_narration", "the_sentinel_write_of_a_failed_first_analysis",
        "the_recommendations_insert"])
def test_the_runs_alerts_are_written_even_when_a_narrative_write_raises(monkeypatch, refused, narration_kind):
    """RULED 2026-10-03: "deterministic alerts must be written by
    stage_persist_narrative even when the briefing / recommendation writes
    raise." Measured on d3c955a7: the raise landed before the alerts; the
    orchestrator swallowed it; on a same-month re-upload the takeover then
    moved NO alerts onto the month (4 -> 0).

    The raise itself still reaches the caller — the orchestrator logs it
    and tells the takeover (`keep_recommendations`)."""
    if narration_kind == "usable":
        narration, _requests = _real_usable_narration(monkeypatch)
        world = dict()
    else:
        narration, _code = _real_failed_narration(monkeypatch, "provider_raises")
        world = dict(stored_body=None, recommendations=False)
    # POSITIVE CONTROL: on a database that answers, the very same call
    # performs the write this scenario refuses.
    answering = _world(**world)
    _persist(answering, copy.deepcopy(narration))
    assert [w for w in answering.writes if (w["op"], w["table"]) == refused and not w["refused"]], \
        "the control never performed %r" % (refused,)

    double = _seed_like(_world(**world), _RefusingDouble((refused,)))
    briefings_before = copy.deepcopy(double.rows("briefings"))
    foreign_before = _foreign(double)

    raised = _persist_catching(double, copy.deepcopy(narration))

    assert isinstance(raised, httpx.ReadTimeout), \
        "the database's refusal must reach the caller, got %r" % (raised,)
    _assert_the_runs_alerts_are_stored(double, "%s refused" % (refused,))
    assert OLD_ALERT_KEY not in [a["alert_key"] for a in double.rows("alerts")]
    if refused == ("upsert", "briefings"):
        # Nothing of the narrative was written: the briefing and the
        # recommendations are what they were.
        assert double.rows("briefings") == briefings_before
        assert [w for w in double.writes if w["table"] == "recommendations"] == []
    assert _foreign(double) == foreign_before


#: Values the module's own predicate (`narration_unavailable_code`) calls an
#: unavailable narration, which the real `stage_narrate` does not return
#: today (every real failure branch carries both keys — the W8 test above).
_UNAVAILABLE_WITHOUT_RECOMMENDATIONS = {
    "a_coded_failure_with_no_recommendations_key": {"briefing": "x", "unavailable": "no_api_key"},
    "no_result_at_all": None,
}  # type: Dict[str, Any]


@pytest.mark.parametrize("shape", sorted(_UNAVAILABLE_WITHOUT_RECOMMENDATIONS))
def test_whatever_the_predicate_calls_unavailable_the_writer_persists_as_a_first_analysis(shape):
    """LATENT on d3c955a7 (not reachable through the real `stage_narrate`
    today): the predicate tolerates a non-dict and a dict without
    `recommendations` (it answers a code for both); the writer then
    upserted the sentinel, deleted the period's recommendations and raised
    on `narrate["recommendations"]` — before the alerts. Repaired: a failed
    narration reads no recommendations at all.

    SPEC D6b: an unusable narration with nothing to protect stores the
    neutral sentinel; the writer's contract: the alerts in every case."""
    narration = copy.deepcopy(_UNAVAILABLE_WITHOUT_RECOMMENDATIONS[shape])
    assert P.narration_unavailable_code(narration) is not None, \
        "PRECONDITION: the predicate must call %r unavailable" % (narration,)
    double = _world(stored_body=None, recommendations=False)

    raised = _persist_catching(double, narration)

    stored = sorted(a["alert_key"] for a in _of_period(double, "alerts"))
    assert raised is None and stored == RUN_ALERT_KEYS, (
        "%s: the writer raised %r; the alerts stored are %r (the run's are %r)"
        % (shape, raised, stored, RUN_ALERT_KEYS))
    assert [r["body"] for r in _of_period(double, "briefings")] == ["[NARRATIVE_UNAVAILABLE]"]
    assert _writes(double, "recommendations") == []


# ══════════════════════════════════════════════════════════════════════
# The takeover at its own seam — a staged run that left NO briefing row
# ══════════════════════════════════════════════════════════════════════

STAGED_PID = "b1ef0000-0000-4000-8000-00000057a6ed"
FIRST_DOC_ID = "doc-of-the-first-upload"


def _takeover_world(*, staged_body: Optional[str], served_body: Optional[str] = GOOD_BODY,
                    staged_recommendations: bool = False) -> RecordingDouble:
    """The month (PID: its briefing `served_body` — None = no row —, two
    worked recommendations, the first upload's document) and the re-upload's
    staged period beside it — with the briefing row its run stored, or none,
    and (`staged_recommendations`) the recommendation its run stored.
    Another tenant's period, briefing and recommendation stand beside them."""
    double = RecordingDouble(every_table=True)
    double.add("financial_periods", {"id": PID, "org_id": ORG, "currency": "RON",
                                     "source_document_id": FIRST_DOC_ID,
                                     "period_start": "2025-12-01", "period_end": "2025-12-31"})
    double.add("financial_periods", {"id": STAGED_PID, "org_id": ORG, "currency": "RON",
                                     "source_document_id": DOC_ID,
                                     "period_start": "2025-12-01", "period_end": "2025-12-31"})
    double.add("financial_periods", {"id": OTHER_PID, "org_id": OTHER_ORG, "currency": "RON",
                                     "period_start": "2025-12-01", "period_end": "2025-12-31"})
    for doc_id, period_id in ((FIRST_DOC_ID, PID), (DOC_ID, None)):
        double.add("documents", {"id": doc_id, "org_id": ORG, "status": "analyzed",
                                 "period_id": period_id, "deleted_at": None})
    if served_body is not None:
        double.add("briefings", {"id": "briefing-of-the-month", "period_id": PID, "org_id": ORG,
                                 "body": served_body, "language": "ro", "model": "the-model-of-the-stored-write",
                                 "created_at": "2026-09-01T09:00:00+00:00",
                                 "ebitda_definition": CURRENT_DEFINITION})
    if staged_body is not None:
        double.add("briefings", {"id": "briefing-of-the-staged-run", "period_id": STAGED_PID,
                                 "org_id": ORG, "body": staged_body, "language": "ro",
                                 "model": "the-model-of-the-staged-write",
                                 "ebitda_definition": CURRENT_DEFINITION})
    double.add("briefings", {"id": "briefing-of-the-other-tenant", "period_id": OTHER_PID,
                             "org_id": OTHER_ORG, "body": "The other tenant's briefing.",
                             "language": "en", "model": "the-model-of-the-stored-write"})
    for rec_id, status in (("rec-1", "in_progress"), ("rec-2", "new")):
        double.add("recommendations", {"id": rec_id, "org_id": ORG, "period_id": PID,
                                       "target_type": "dataset", "target_id": PID, "title": rec_id,
                                       "explanation": "…", "urgency": "high", "status": status})
    if staged_recommendations:
        double.add("recommendations", {"id": "rec-of-the-staged-run", "org_id": ORG, "period_id": STAGED_PID,
                                       "target_type": "dataset", "target_id": STAGED_PID,
                                       "title": NEW_RECOMMENDATION, "explanation": "…",
                                       "urgency": "high", "status": "new"})
    double.add("recommendations", {"id": "rec-of-the-other-tenant", "org_id": OTHER_ORG,
                                   "period_id": OTHER_PID, "target_type": "dataset", "target_id": OTHER_PID,
                                   "title": "Theirs", "explanation": "Theirs.", "urgency": "low", "status": "new"})
    return double


def _take_over(double: RecordingDouble, **kwargs: Any) -> str:
    """The REAL `_finalize_same_month_takeover`, called as the orchestrator
    calls it: the run recorded as staged beside the month, then finalized."""
    P._record_takeover(DOC_ID, staged=STAGED_PID, served=PID, superseded_document=FIRST_DOC_ID)
    try:
        with RA.installed(double):
            return P._finalize_same_month_takeover({"id": DOC_ID, "org_id": ORG}, STAGED_PID, **kwargs)
    finally:
        P._pop_takeover(DOC_ID)


def _assert_the_takeover_happened(double: RecordingDouble) -> None:
    """POSITIVE CONTROL of every keep below: the month WAS taken over — one
    period row of ORG, the month's, naming the new document."""
    (period,) = [p for p in double.rows("financial_periods") if p["org_id"] == ORG]
    assert period["id"] == PID and period["source_document_id"] == DOC_ID, period


_NO_STAGED_ROW_CALLS = {
    # The classical lane: `stage_persist_narrative` raised before its upsert
    # (swallowed as non-fatal) and the orchestrator passes the run's code.
    "the_run_says_provider_error": ({"narration_unavailable": "provider_error"}, "provider_error"),
    # The classical lane after a USABLE narration whose write was lost, and
    # the AI lane (pipeline.py — `_finalize_same_month_takeover(doc,
    # period_id)` right after `stage_persist`: that lane never narrates).
    # No code arrived and no row: the kept briefing is marked `empty_reply`.
    "the_caller_passes_no_code": ({}, "empty_reply"),
}  # type: Dict[str, Tuple[Dict[str, Any], str]]


@pytest.mark.parametrize("call", sorted(_NO_STAGED_ROW_CALLS))
def test_a_takeover_whose_staged_run_left_no_briefing_row_keeps_the_months_briefing(call):
    """Measured on d3c955a7: briefings [GOOD] -> [], recommendations 2 -> 0.

    SPEC D6: "No writer may replace a usable briefing with an unusable
    one"; D6c: the takeover does not replace the served month's usable
    briefing with a staged one that is unusable. NO staged row is the
    least usable briefing there is (the module's own predicate says so of
    `None`) — and the takeover's keep decision required a staged row to
    exist (`staged_briefing is not None and …`), ignoring the code its
    caller handed it. So it deleted the month's briefing and moved nothing
    into its place; the run still ended `analyzed`.

    RULED 2026-10-03: "keep the month's recommendations too. A takeover
    must not delete anything that was good." """
    kwargs, reason = _NO_STAGED_ROW_CALLS[call]
    double = _takeover_world(staged_body=None)
    before = copy.deepcopy(_of_period(double, "briefings"))
    recommendations_before = copy.deepcopy(double.rows("recommendations"))
    foreign_before = _foreign(double)

    assert _take_over(double, **kwargs) == PID  # the takeover happened
    _assert_the_takeover_happened(double)

    after = _of_period(double, "briefings")
    assert [_sans_marker(r) for r in after] == [_sans_marker(r) for r in before], (
        "%s: the takeover left the month with %d briefing row(s) — its last good briefing is gone "
        "and nothing replaced it" % (call, len(after)))
    assert after[0]["stale_reason"] == reason and _is_a_timestamp(after[0]["stale_since"]), after[0]
    assert double.rows("recommendations") == recommendations_before, \
        "%s: the takeover did not keep the month's recommendations exactly" % call
    # The month's own rows were never deleted: every delete on the two
    # tables names the STAGED id — and the tenant.
    for table in ("briefings", "recommendations"):
        for delete in _writes(double, table, "delete"):
            assert delete["filters"] == {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}, \
                "%s: a delete on %s that is not the staged run's own: %r" % (call, table, delete["filters"])
    assert _foreign(double) == foreign_before


def test_a_takeover_whose_staged_run_stored_a_usable_briefing_replaces_the_months():
    """POSITIVE CONTROL of the law above at the same seam (a blanket "never
    touch the month's briefing / recommendations" passes it), and the staged
    failure text: the month's briefing kept, marked with the code the caller
    passed, the staged row deleted with the tenant in the filter."""
    usable = _takeover_world(staged_body=NEW_BODY, staged_recommendations=True)
    foreign_before = _foreign(usable)
    assert _take_over(usable) == PID
    _assert_the_takeover_happened(usable)
    (row,) = [b for b in usable.rows("briefings") if b["org_id"] == ORG]
    assert row["body"] == NEW_BODY and row["period_id"] == PID, row
    # …and the month's recommendations ARE the staged run's now.
    assert [(r["id"], r["period_id"]) for r in usable.rows("recommendations") if r["org_id"] == ORG] == \
        [("rec-of-the-staged-run", PID)], usable.rows("recommendations")
    assert _foreign(usable) == foreign_before

    failed = _takeover_world(staged_body="[NARRATIVE_UNAVAILABLE]")
    before = copy.deepcopy(_of_period(failed, "briefings"))
    assert _take_over(failed, narration_unavailable="unparseable_reply") == PID
    (kept,) = [b for b in failed.rows("briefings") if b["org_id"] == ORG]
    assert _sans_marker(kept) == _sans_marker(before[0]), kept
    assert kept["stale_reason"] == "unparseable_reply" and _is_a_timestamp(kept["stale_since"]), kept
    (staged_delete,) = _writes(failed, "briefings", "delete")
    assert staged_delete["filters"] == {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}, \
        "the staged briefing must be deleted with the tenant in the filter: %r" % staged_delete["filters"]


#: THE CELLS IN WHICH THE TAKEOVER KEEPS THE MONTH'S RECOMMENDATIONS (ruling
#: 2026-10-03): the staged narration is unusable — whatever the month's own
#: briefing row holds — or the orchestrator says the run stored none to
#: replace them with. id -> (the takeover world, the call's kwargs, the
#: bodies ORG's briefings hold afterwards).
_KEEPS_THE_RECOMMENDATIONS = {
    "a_staged_failure_text_beside_a_usable_briefing": (
        dict(staged_body="[NARRATIVE_UNAVAILABLE]"), dict(narration_unavailable="provider_error"),
        [GOOD_BODY]),
    # The state the pre-repair regenerate left in production: the sentinel
    # over the briefing, the worked recommendations untouched.
    "a_staged_failure_text_beside_a_stored_failure_text": (
        dict(staged_body="[NARRATIVE_UNAVAILABLE]", served_body="[NARRATIVE_UNAVAILABLE]"),
        dict(narration_unavailable="provider_error"), ["[NARRATIVE_UNAVAILABLE]"]),
    "no_staged_row_beside_a_stored_failure_text": (
        dict(staged_body=None, served_body="Set ANTHROPIC_API_KEY on the backend to enable AI narrative."),
        dict(narration_unavailable="no_api_key"),
        ["Set ANTHROPIC_API_KEY on the backend to enable AI narrative."]),
    "no_staged_row_and_no_briefing_of_the_month": (
        dict(staged_body=None, served_body=None), dict(), []),
    # A usable staged briefing DOES move; its run stored no recommendations
    # that may replace the month's (unreadable, or the write raised).
    "a_usable_staged_briefing_whose_recommendations_must_not_replace": (
        dict(staged_body=NEW_BODY), dict(keep_recommendations=True), [NEW_BODY]),
}  # type: Dict[str, Tuple[Dict[str, Any], Dict[str, Any], List[str]]]


@pytest.mark.parametrize("staged_recommendations", [False, True],
                         ids=["the_staged_run_stored_no_recommendations", "the_staged_run_stored_one"])
@pytest.mark.parametrize("cell", sorted(_KEEPS_THE_RECOMMENDATIONS))
def test_a_takeover_that_brings_no_usable_narration_keeps_the_months_recommendations(cell, staged_recommendations):
    """RULED 2026-10-03: "Takeover: keep the month's recommendations too. A
    takeover must not delete anything that was good." Measured on d3c955a7:
    the takeover that KEPT the month's briefing deleted its recommendations
    (2 -> 0) — `recommendations` was in the generic loop, and a failed
    staged run has none to move.

    The month's two worked recommendations come out exactly as they went
    in; a recommendation the staged run did store is removed by a delete of
    its own with the tenant in the filter; nothing is left under the staged
    id. (The positive control — a usable, readable staged narration
    REPLACES them — is the test above.)"""
    world, kwargs, bodies_after = _KEEPS_THE_RECOMMENDATIONS[cell]
    double = _takeover_world(staged_recommendations=staged_recommendations, **world)
    mine_before = copy.deepcopy(_of_period(double, "recommendations"))
    assert [(r["id"], r["status"]) for r in mine_before] == [("rec-1", "in_progress"), ("rec-2", "new")]
    foreign_before = _foreign(double)

    assert _take_over(double, **kwargs) == PID
    _assert_the_takeover_happened(double)

    assert _of_period(double, "recommendations") == mine_before, (
        "%s: the takeover cost the month its recommendations: %r"
        % (cell, _of_period(double, "recommendations")))
    assert [b["body"] for b in _of_period(double, "briefings")] == bodies_after, \
        (cell, _of_period(double, "briefings"))
    # NOTHING LEFT UNDER THE STAGED ID in the two tables, and the staged
    # run's recommendation went by a delete naming the staged id AND the
    # tenant — the month's own were never deleted.
    for table in ("briefings", "recommendations"):
        assert _of_period(double, table, STAGED_PID) == [], (cell, table)
    deletes = _writes(double, "recommendations", "delete")
    assert [d["filters"] for d in deletes] == \
        [{"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}], deletes
    assert _foreign(double) == foreign_before


# ══════════════════════════════════════════════════════════════════════
# The SKU scope — `sku_analyses.briefing`, the fourth writer of a briefing
# ══════════════════════════════════════════════════════════════════════

SKU_DOC_ID = "doc-sku-keep-last-good"
SKU_GOOD_BRIEFING = ("Portofoliul este concentrat: primele zece produse aduc două treimi din "
                     "vânzări, iar coada lungă imobilizează stoc.")
SKU_RECOMMENDATIONS = [{"severity": "high", "title": "Delistează produsele cu marjă negativă",
                        "rationale": "Consumă capital fără să aducă marjă.", "actions": ["Stabilește lista"]}]
SKU_PARSED = {"skus": [], "summary": {"sku_count": 406}, "period_label": "2025"}


#: A row of ANOTHER tenant — never read, never written.
SKU_FOREIGN_ROW = {"id": "sku-analysis-of-the-other-tenant", "org_id": OTHER_ORG,
                   "document_id": "doc-sku-of-the-other-tenant", "briefing": "Theirs.",
                   "summary": {"sku_count": 7}, "recommendations": [{"title": "Theirs"}],
                   "language": "en", "model": "the-model-of-the-stored-write"}
_NO_SKU_ROW = object()


def _sku_world(stored_briefing: Any = SKU_GOOD_BRIEFING) -> RecordingDouble:
    """The document's stored SKU analysis (`stored_briefing`; `_NO_SKU_ROW`
    = a first analysis) — a summary of the PREVIOUS run (405 products) —
    beside another tenant's."""
    double = RecordingDouble(every_table=True)
    if stored_briefing is not _NO_SKU_ROW:
        double.add("sku_analyses", {"id": "sku-analysis-of-the-document", "org_id": ORG,
                                    "document_id": SKU_DOC_ID, "briefing": stored_briefing,
                                    "summary": {"sku_count": 405},
                                    "recommendations": copy.deepcopy(SKU_RECOMMENDATIONS),
                                    "language": "en", "model": "the-model-of-the-stored-write"})
    double.add("sku_analyses", copy.deepcopy(SKU_FOREIGN_ROW))
    return double


def _sku_row(double: RecordingDouble) -> Dict[str, Any]:
    (row,) = [r for r in double.rows("sku_analyses") if r.get("document_id") == SKU_DOC_ID]
    return row


def _assert_the_other_tenants_sku_row_is_untouched(double: RecordingDouble) -> None:
    (theirs,) = [r for r in double.rows("sku_analyses") if r.get("org_id") == OTHER_ORG]
    # (The double fills the columns a row does not name with null.)
    assert dict((k, v) for k, v in theirs.items() if v is not None) == SKU_FOREIGN_ROW, theirs


def _persist_sku(double: RecordingDouble, narration: Dict[str, Any]) -> None:
    """The REAL `_persist_sku_analysis` (what the pipeline's SKU branch
    calls with `stage_narrate`'s result), the database doubled."""
    with RA.installed(double):
        P._persist_sku_analysis({"id": SKU_DOC_ID, "org_id": ORG}, copy.deepcopy(SKU_PARSED), narration)


@pytest.mark.parametrize("branch", ["no_api_key", "provider_raises", "reply_is_not_json"])
def test_a_failed_narration_never_replaces_a_usable_sku_briefing(monkeypatch, branch):
    """RULED 2026-10-03: the SKU briefing is in scope — "a failed narration
    never replaces a usable sku_analyses.briefing (same keep-last-good
    rule)". SPEC D6, its header: "No writer may replace a usable briefing
    with an unusable one." Measured on d3c955a7: the SKU branch of the
    pipeline handed `stage_narrate`'s result to `_persist_sku_analysis`
    with no predicate, and a re-run of a sales document whose narration
    failed stored the operator sentence / the sentinel / the first 500
    characters of the reply over `sku_analyses.briefing` and replaced its
    recommendations with [].

    The briefing, the recommendations and the stamps of the write that
    produced them are kept; the run's deterministic summary IS written;
    the stored row is read with the tenant in the filter."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _sku_world()
    before = copy.deepcopy(_sku_row(double))

    _persist_sku(double, narration)

    row = _sku_row(double)
    assert row["briefing"] == SKU_GOOD_BRIEFING, (
        "%s: the stored SKU briefing became %r" % (branch, row["briefing"]))
    assert row["recommendations"] == SKU_RECOMMENDATIONS, (
        "%s: the stored SKU recommendations became %r" % (branch, row["recommendations"]))
    # THE WHOLE ROW, the run's summary aside — language and model are the
    # stamps of the write that produced the kept briefing.
    assert dict(row, summary=None) == dict(before, summary=None), row
    assert row["summary"] == {"sku_count": 406}, "the run's deterministic summary was not written"
    # No write of this run NAMES the briefing or the recommendations.
    for write in _writes(double, "sku_analyses"):
        assert write["op"] == "upsert" and write["on_conflict"] == "document_id", write
        assert not set(write["payload"]) & {"briefing", "recommendations", "language", "model"}, \
            "%s: the kept row was written over: %r" % (branch, sorted(write["payload"]))
    # The stored row was READ with the tenant in the filter (service role).
    reads = double.selects("sku_analyses")
    assert reads, "%s: the writer never read the stored SKU analysis" % branch
    for _op, _table, filters, _columns in reads:
        assert filters == {"document_id": "eq.%s" % SKU_DOC_ID, "org_id": "eq.%s" % ORG}, filters
    _assert_the_other_tenants_sku_row_is_untouched(double)


def test_a_usable_narration_replaces_the_sku_briefing(monkeypatch):
    """POSITIVE CONTROL of the SKU law: a narration that worked IS written
    — over a usable briefing and over a stored failure text alike."""
    monkeypatch.setattr(P, "_NARRATIVE_MODEL", "narrative-model-of-this-test", raising=False)
    narration, _requests = _real_usable_narration(monkeypatch)
    for stored in (SKU_GOOD_BRIEFING, "[NARRATIVE_UNAVAILABLE]"):
        double = _sku_world(stored)

        _persist_sku(double, narration)

        row = _sku_row(double)
        assert row["briefing"] == NEW_BODY and row["org_id"] == ORG, row
        assert [r["title"] for r in row["recommendations"]] == ["Scurtează termenele de încasare"]
        assert row["model"] == "narrative-model-of-this-test" and row["summary"] == {"sku_count": 406}, row
        _assert_the_other_tenants_sku_row_is_untouched(double)


#: What a `sku_analyses.briefing` written before the repair can hold where
#: a failed narration finds nothing usable to keep.
_SKU_NOTHING_USABLE = {
    "a_first_analysis": _NO_SKU_ROW,
    "the_operator_sentence_for_a_missing_key": "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.",
    "the_sentinel": "[NARRATIVE_UNAVAILABLE]",
    "a_null_briefing": None,
}  # type: Dict[str, Any]


@pytest.mark.parametrize("branch", ["no_api_key", "provider_raises", "reply_is_not_json"])
@pytest.mark.parametrize("stored", sorted(_SKU_NOTHING_USABLE))
def test_a_failed_sku_narration_with_nothing_usable_stored_writes_exactly_the_sentinel(
        monkeypatch, stored, branch):
    """The other half of the same rule (SPEC D6b, for the SKU writer): an
    unusable narration with nothing to protect stores the neutral sentinel
    — never the operator sentence, never provider text, never a fragment of
    the reply (measured on d3c955a7: all three). And a failed narration
    never writes over RECOMMENDATIONS a stored row holds."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _sku_world(_SKU_NOTHING_USABLE[stored])

    _persist_sku(double, narration)

    row = _sku_row(double)
    assert row["briefing"] == "[NARRATIVE_UNAVAILABLE]", \
        "stored %s + %s: the SKU briefing is %r" % (stored, branch, row["briefing"])
    assert row["org_id"] == ORG and row["summary"] == {"sku_count": 406}, row
    for value in _strings_in(row):
        for fragment in FORBIDDEN_IN_A_STORED_ROW:
            assert fragment not in value, (stored, branch, row)
    if _SKU_NOTHING_USABLE[stored] is _NO_SKU_ROW:
        assert row["recommendations"] == [], row["recommendations"]
    else:
        assert row["recommendations"] == SKU_RECOMMENDATIONS, (
            "stored %s + %s: a failed narration replaced the stored SKU recommendations with %r"
            % (stored, branch, row["recommendations"]))
    _assert_the_other_tenants_sku_row_is_untouched(double)


# ══════════════════════════════════════════════════════════════════════
# W6 / W7 — through the real orchestrator (the `gw` world)
# ══════════════════════════════════════════════════════════════════════

BODY_A = "Primul comentariu: vânzările au crescut, iar marja operațională s-a menținut."
BODY_B = "Al doilea comentariu: lichiditatea s-a îmbunătățit, iar îndatorarea rămâne redusă."
TITLES_A = ["Renegociază termenele cu furnizorii", "Scurtează termenele de încasare"]
TITLES_B = ["Revizuiește politica de stocuri"]


def _reply(body: str, titles: List[str]) -> str:
    return json.dumps({"briefing": body, "recommendations": [
        {"severity": "high", "category": "financial", "title": title,
         "rationale": "Ciclul de numerar este lung.", "actions": ["Stabilește un responsabil"],
         "estimated_ron_impact": None, "metric_referenced": "ccc"} for title in titles]},
        ensure_ascii=False)


class _ScriptedProvider(object):
    """`anthropic.Anthropic` in the `gw` world. A NARRATE request (its user
    payload carries `briefing_facts`) gets the next outcome of the script —
    a reply text, or an exception to raise. Every other request (the
    council's) is refused exactly as `V._NoCreditAnthropic` refuses it, so
    the rest of the run is the house harness's, unchanged."""

    script = []  # type: List[Any]
    narrate_requests = []  # type: List[Dict[str, Any]]

    def __init__(self, *a: Any, **kw: Any) -> None:
        self.messages = self

    def create(self, *a: Any, **kw: Any) -> Any:
        content = ((kw.get("messages") or [{}])[0] or {}).get("content")
        if not (isinstance(content, str) and '"briefing_facts"' in content):
            raise RuntimeError("Your credit balance is too low to access the Anthropic API.")
        _ScriptedProvider.narrate_requests.append(kw)
        if not _ScriptedProvider.script:
            raise RuntimeError("an unscripted narrate request")
        outcome = _ScriptedProvider.script.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return _Reply(outcome)

    def stream(self, *a: Any, **kw: Any) -> Any:
        return self.create(*a, **kw)


def _script_the_provider(monkeypatch, outcomes: List[Any]) -> None:
    stub = types.ModuleType("anthropic")
    stub.Anthropic = _ScriptedProvider  # type: ignore[attr-defined]
    stub.APIStatusError = RuntimeError  # type: ignore[attr-defined]
    stub.APIError = RuntimeError  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", stub)
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    monkeypatch.setattr(_ScriptedProvider, "script", list(outcomes))
    monkeypatch.setattr(_ScriptedProvider, "narrate_requests", [])


def _assert_every_run_reached_the_provider(runs: int) -> None:
    """The floor of the orchestrated laws: a run that never narrated would
    "keep" the briefing for the wrong reason."""
    assert len(_ScriptedProvider.narrate_requests) == runs and _ScriptedProvider.script == [], (
        "expected %d narrate request(s) and an empty script; saw %d, %d outcome(s) left"
        % (runs, len(_ScriptedProvider.narrate_requests), len(_ScriptedProvider.script)))


#: The instruction `stage_narrate` gives the model, and the stamp it means.
_LANGUAGE_INSTRUCTIONS = {"Răspunde în limba română.": "ro", "Reply in English.": "en"}


def _language_the_last_narration_was_written_in() -> str:
    """Read off the provider request itself — the language the model was
    TOLD to write in is the briefing's true language (SPEC D9)."""
    system = _ScriptedProvider.narrate_requests[-1]["system"]
    told = [stamp for instruction, stamp in _LANGUAGE_INSTRUCTIONS.items() if instruction in system]
    assert len(told) == 1, "the narrate request names %d of the two languages" % len(told)
    return told[0]


#: The ways the second run's narration fails, with the run's OWN code.
_FAILING_OUTCOMES = {
    "provider_raises": (lambda: RuntimeError(PROVIDER_ERROR_TEXT), "provider_error"),
    "reply_is_not_json": (lambda: REPLY_FRAGMENT, "unparseable_reply"),
    "reply_is_empty": (lambda: "", "empty_reply"),
}


class _Spy(object):
    """Every write the engine makes on the `gw` double — payload, filters
    and what the double answered recorded (an attempt the double REFUSES is
    recorded too, `refused: True`); the double still performs it."""

    def __init__(self, db: Any, monkeypatch) -> None:
        self.writes = []  # type: List[Dict[str, Any]]
        for op in ("insert", "upsert", "update", "delete"):
            monkeypatch.setattr(db, op, self._recording(op, getattr(db, op)))

    def _recording(self, op: str, real: Callable[..., Any]) -> Callable[..., Any]:
        def call(table: str, *args: Any, **kwargs: Any) -> Any:
            entry = {"op": op, "table": table,
                     "payload": copy.deepcopy(args[0]) if args else None,
                     "filters": dict(kwargs.get("filters") or {}),
                     "on_conflict": kwargs.get("on_conflict"),
                     "returned": None, "refused": False}
            self.writes.append(entry)
            try:
                out = real(table, *args, **kwargs)
            except Exception:
                entry["refused"] = True
                raise
            entry["returned"] = copy.deepcopy(out)
            return out
        return call


def _before_the_stale_migration(gw) -> None:
    """`briefings` in the `gw` world as it stands BEFORE
    supabase/schema_phase_briefing_stale.sql is applied — deploy day, by the
    SPEC's own design (D7: "optional until applied") — with the proof that
    this double then refuses the marker as PostgREST would (400 42703).
    Call it before the first analysis: the rows are then stored without the
    two columns."""
    gw.db.columns["briefings"] = [c for c in gw.db.columns["briefings"] if c not in STALE_COLUMNS]
    with pytest.raises(httpx.HTTPStatusError):
        gw.db.update("briefings", {"stale_reason": "provider_error"},
                     filters={"period_id": "eq.no-such-period"})


_MIGRATION_STATES = ["stale_migration_applied", "stale_migration_not_applied"]


def _marker_updates(spy: _Spy) -> List[Dict[str, Any]]:
    return [w for w in _writes(spy, "briefings", "update")
            if set(w["payload"] or {}) & set(STALE_COLUMNS)]


def _served_period(app, org_id: str, period_id: str) -> Dict[str, Any]:
    r = V._http(app).get("/api/period/%s" % period_id, headers=V._headers(V.USER, org_id))
    assert r.status_code == 200, r.text[:400]
    return r.json()


def _first_analysis(app, gw) -> Dict[str, Any]:
    """Agras's December analysed by the real pipeline with a narration that
    WORKED — and the proof that it was written (the positive control every
    orchestrated law below starts from)."""
    first = V._analysed_month(app, gw, V.agras_workbook())
    period_id, org_id = first["period"]["id"], first["doc"]["org_id"]
    briefings = gw.db.rows("briefings")
    assert len(briefings) == 1 and briefings[0]["body"] == BODY_A and \
        briefings[0]["period_id"] == period_id, briefings
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_A
    alert_keys = sorted(a["alert_key"] for a in gw.db.rows("alerts"))
    assert alert_keys, "the book raises deterministic alerts"
    return dict(first, period_id=period_id, org_id=org_id, alert_keys=alert_keys,
                briefings=copy.deepcopy(briefings),
                recommendations=copy.deepcopy(gw.db.rows("recommendations")))


@pytest.mark.parametrize("migration", _MIGRATION_STATES)
def test_a_rerun_whose_narration_fails_leaves_the_served_briefing_and_recommendations_intact(
        app, gw, monkeypatch, migration):
    """Measured before the repair (scout_briefing §0): the briefing became
    the sentinel and the recommendations were deleted. Driven in both
    states of the stale migration: deploy day is the NOT-applied one."""
    applied = migration == "stale_migration_applied"
    if not applied:
        _before_the_stale_migration(gw)
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), RuntimeError(PROVIDER_ERROR_TEXT)])
    first = _first_analysis(app, gw)
    spy = _Spy(gw.db, monkeypatch)

    rerun = V.run_analysis(gw, first["doc"]["id"])  # the same document, again

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [first["period_id"]]
    after = gw.db.rows("briefings")
    if applied:
        # THE STORED ROWS — whole, the marker aside; and the marker.
        assert [_sans_marker(r) for r in after] == [_sans_marker(r) for r in first["briefings"]], \
            "the re-run changed the stored briefing: %r" % after
        assert after[0]["stale_reason"] == "provider_error" and _is_a_timestamp(after[0]["stale_since"]), after
    else:
        # THE STORED ROWS — whole: there is no marker column to set aside.
        assert not set(after[0]) & set(STALE_COLUMNS)
        assert after == first["briefings"], \
            "before the migration, the re-run changed the stored briefing: %r" % after
    assert gw.db.rows("recommendations") == first["recommendations"], \
        "the re-run did not keep the period's recommendations"
    assert _writes(spy, "briefings", "upsert") == [] and _writes(spy, "briefings", "delete") == []
    assert _writes(spy, "recommendations") == [], _writes(spy, "recommendations")
    # ONE marker update, the tenant in its filter — stored when the columns
    # exist, refused (and swallowed) when they do not.
    (marker,) = _marker_updates(spy)
    assert marker["filters"] == {"period_id": "eq.%s" % first["period_id"],
                                 "org_id": "eq.%s" % first["org_id"]}, marker["filters"]
    assert marker["refused"] is (not applied), marker
    # The deterministic alerts were written again.
    assert _writes(spy, "alerts", "upsert"), "the re-run wrote no alerts"
    assert sorted(a["alert_key"] for a in gw.db.rows("alerts")) == first["alert_keys"]
    # WHAT THE READER IS SERVED.
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_A, body["briefing"]
    assert body["briefing"]["unavailable"] is False
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A
    if applied:
        assert body["briefing"]["stale"] == {"since": after[0]["stale_since"], "reason": "provider_error"}
    # (Not applied: nothing durable says the kept briefing is stale — see
    # OBSERVED in the module docstring; not asserted.)


def test_a_rerun_whose_narration_works_replaces_the_briefing_and_the_recommendations_and_clears_the_marker(
        app, gw, monkeypatch):
    """POSITIVE CONTROL of the law above: good, failed (kept, stale), good."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), RuntimeError(PROVIDER_ERROR_TEXT),
                                       _reply(BODY_B, TITLES_B)])
    first = _first_analysis(app, gw)
    # The card's upload asks for Romanian: told Romanian, stamped Romanian.
    assert first["briefings"][0]["language"] == _language_the_last_narration_was_written_in() == "ro", \
        first["briefings"][0]["language"]
    doc_id = first["doc"]["id"]
    V.run_analysis(gw, doc_id)
    (kept,) = gw.db.rows("briefings")
    assert kept["body"] == BODY_A and kept["stale_reason"] == "provider_error"
    spy = _Spy(gw.db, monkeypatch)

    third = V.run_analysis(gw, doc_id)

    assert third["status"] == "analyzed", (third["status"], third.get("error"))
    _assert_every_run_reached_the_provider(3)
    (row,) = gw.db.rows("briefings")
    assert row["body"] == BODY_B and row["period_id"] == first["period_id"], row
    # (A re-run that does not come through POST /api/pipeline/run narrates in
    # the language the detector stored on the document after the first run.)
    assert row["language"] == _language_the_last_narration_was_written_in(), row["language"]
    assert row["stale_since"] is None and row["stale_reason"] is None, "a good write left the marker"
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_B
    for upsert in _writes(spy, "briefings", "upsert"):
        assert not set(upsert["payload"]) & set(STALE_COLUMNS), upsert["payload"]
    assert len(_writes(spy, "briefings", "upsert")) == 1
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["stale"] is None, body["briefing"]


def _corrected_december() -> bytes:
    """The same company's December again, with other figures (the other
    corpus book under Agras's header): the replacement shows in every number."""
    return V.book_workbook(V.SCANDIA_BOOK, name="AGRAS SRL", cui=V.CUI_AGRAS)


def _reupload(app, gw, org_id: str) -> Dict[str, Any]:
    second = V.one_tap(app, _corrected_december(), "balanta_corectata.xlsx")
    assert second["commit"]["org_id"] == org_id and second["commit"]["status"] == "queued", second["commit"]
    return V.run_analysis(gw, second["commit"]["document_id"])


def _staged_period_ids(spy: _Spy, served_period_id: str) -> List[str]:
    """The period id(s) the re-upload's run MINTED beside the month — read
    off its own `financial_periods` insert (what the database answered),
    never off a briefing write: a repair may well stop writing a briefing
    under a staged id."""
    ids = sorted(set(str(row["id"]) for w in _writes(spy, "financial_periods", "insert")
                     for row in (w["returned"] or [])))
    assert ids and served_period_id not in ids, \
        "the re-upload must be staged under a period row of its own: %r" % ids
    return ids


def _assert_nothing_is_left_under(gw, staged: List[str], what: str) -> None:
    for staged_id in staged:
        left = dict((t, rows) for t, rows in V._rows_under(gw, staged_id).items() if rows)
        assert left == {}, "%s: rows are left under the staged period %s: %r" % (what, staged_id, left)


@pytest.mark.parametrize("migration", _MIGRATION_STATES)
@pytest.mark.parametrize("failure", sorted(_FAILING_OUTCOMES))
def test_a_same_month_reupload_whose_narration_fails_replaces_the_statements_but_keeps_the_months_briefing(
        app, gw, monkeypatch, failure, migration):
    """Read from the code before the repair (scout_briefing §6.2): the
    takeover deleted the month's briefing and moved the staged run's
    sentinel into its place. Driven in both states of the stale migration
    (the takeover marks the row in the middle of a four-step sequence that
    is not atomic: a mark that stopped being best-effort would leave the
    month half replaced)."""
    applied = migration == "stale_migration_applied"
    if not applied:
        _before_the_stale_migration(gw)
    make_outcome, code = _FAILING_OUTCOMES[failure]
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), make_outcome()])
    first = _first_analysis(app, gw)
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, first["org_id"])

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    # POSITIVE CONTROL — the takeover itself happened, to its last step:
    # one period, the corrected document's, serving the corrected figures.
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == first["period_id"] and period["source_document_id"] == replaced["id"], period
    assert replaced["period_id"] == first["period_id"], "the document is not pinned to the month"
    served = V._served(app, first["org_id"], period["id"])
    assert served["source_document"] == replaced["id"] and served["revenue"] != first["served"]["revenue"]
    after = gw.db.rows("briefings")
    if applied:
        # THE MONTH'S BRIEFING — the whole row, the marker aside; the marker.
        assert [_sans_marker(r) for r in after] == [_sans_marker(r) for r in first["briefings"]], \
            "%s: the takeover replaced the month's usable briefing: %r" % (failure, after)
        assert after[0]["stale_reason"] == code, \
            "%s: marked with %r, the run's own code is %r" % (failure, after[0]["stale_reason"], code)
        assert _is_a_timestamp(after[0]["stale_since"])
    else:
        assert after == first["briefings"], \
            "%s, before the migration: the takeover changed the month's briefing: %r" % (failure, after)
    (marker,) = _marker_updates(spy)
    assert marker["filters"] == {"period_id": "eq.%s" % first["period_id"],
                                 "org_id": "eq.%s" % first["org_id"]}, marker["filters"]
    assert marker["refused"] is (not applied), marker
    for upsert in _writes(spy, "briefings", "upsert"):
        assert not set(upsert["payload"]) & set(STALE_COLUMNS), upsert["payload"]
    # NOTHING LEFT UNDER THE STAGED ID — and the staged failure text went
    # by a delete of its own, the tenant in the filter (it runs under the
    # service role); the month's briefing was never deleted.
    staged = _staged_period_ids(spy, first["period_id"])
    _assert_nothing_is_left_under(gw, staged, failure)
    (staged_id,) = staged
    assert [w["filters"] for w in _writes(spy, "briefings", "delete")] == \
        [{"period_id": "eq.%s" % staged_id, "org_id": "eq.%s" % first["org_id"]}], \
        _writes(spy, "briefings", "delete")
    # Around the kept briefing: the month's alerts are the corrected run's…
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == first["period_id"] and a["document_id"] == replaced["id"]
                          for a in alerts), alerts
    # …and THE MONTH'S RECOMMENDATIONS ARE KEPT WITH IT (ruling 2026-10-03:
    # "keep the month's recommendations too" — measured on d3c955a7: 2 -> 0,
    # the old briefing served beside none). The stored rows, whole; and no
    # delete on the table names the month's own period.
    assert gw.db.rows("recommendations") == first["recommendations"], \
        "%s: the takeover did not keep the month's recommendations: %r" % (
            failure, gw.db.rows("recommendations"))
    assert [w["filters"] for w in _writes(spy, "recommendations", "delete")] == \
        [{"period_id": "eq.%s" % staged_id, "org_id": "eq.%s" % first["org_id"]}], \
        _writes(spy, "recommendations", "delete")
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_A and body["briefing"]["unavailable"] is False
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A, body["recommendations"]
    if applied:
        assert body["briefing"]["stale"] == {"since": after[0]["stale_since"], "reason": code}


def _refuse_staged_briefing_writes(gw, monkeypatch, served_period_id: str) -> List[Any]:
    """The DATABASE refuses (a transient PostgREST timeout) every briefings
    upsert that is not under the month's own period id — i.e. the staged
    run's. Returns the refused payloads."""
    refused = []  # type: List[Any]
    real = gw.db.upsert

    def upsert(table: str, rows: Any, *args: Any, **kwargs: Any) -> Any:
        body = rows if isinstance(rows, list) else [rows]
        if table == "briefings" and any(str(r.get("period_id")) != str(served_period_id) for r in body):
            refused.append(copy.deepcopy(rows))
            raise httpx.ReadTimeout("The read operation timed out")
        return real(table, rows, *args, **kwargs)

    monkeypatch.setattr(gw.db, "upsert", upsert)
    return refused


@pytest.mark.parametrize("second_narration", ["narration_fails", "narration_works"])
def test_a_same_month_reupload_whose_staged_briefing_write_fails_keeps_the_months_briefing(
        app, gw, monkeypatch, second_narration):
    """Measured on d3c955a7 through the real pipeline: status analyzed,
    briefings [BODY_A] -> [], recommendations 2 -> 0, alerts 4 -> 0, GET
    /api/period `briefing: null`.

    SPEC D6 / D6c and the gate sentence "the takeover keeps the served
    month's briefing". The staged run's `stage_persist_narrative` raises
    (here: the database times out on its briefing upsert); the orchestrator
    logs it as non-fatal and goes on to the takeover — which found NO
    staged briefing row, so its keep decision (`staged_briefing is not None
    and …`) was False whatever code the caller passed, and it deleted the
    month's last good briefing with nothing to put in its place. The run
    still ended `analyzed`. Both narrations are driven: one that failed, and
    one that WORKED but whose write was lost — in neither did anything
    usable arrive to replace the month's briefing.

    RULED 2026-10-03: the month's recommendations are kept with it ("a
    takeover must not delete anything that was good"), and the run's
    deterministic alerts are written although its narrative write raised —
    so the month's alerts are the corrected run's, not none."""
    outcome = RuntimeError(PROVIDER_ERROR_TEXT) if second_narration == "narration_fails" \
        else _reply(BODY_B, TITLES_B)
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), outcome])
    first = _first_analysis(app, gw)
    refused = _refuse_staged_briefing_writes(gw, monkeypatch, first["period_id"])

    replaced = _reupload(app, gw, first["org_id"])

    # FLOORS: the staged briefing write was attempted and refused; the run
    # still succeeded and the takeover happened.
    assert len(refused) >= 1, "the staged run never tried to write its briefing"
    _assert_every_run_reached_the_provider(2)
    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == first["period_id"] and period["source_document_id"] == replaced["id"], period
    # THE LAW: the month still holds its last good briefing, whole.
    after = gw.db.rows("briefings")
    assert [_sans_marker(r) for r in after] == [_sans_marker(r) for r in first["briefings"]], (
        "%s: the staged briefing write failed and the takeover left the month with %d briefing "
        "row(s) — its last good briefing is gone and nothing replaced it"
        % (second_narration, len(after)))
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"] is not None and body["briefing"]["body"] == BODY_A, body["briefing"]
    # No code arrived with a narration that worked: `empty_reply` — nothing
    # was delivered to replace the briefing (decided by the repair).
    assert after[0]["stale_reason"] == (
        "provider_error" if second_narration == "narration_fails" else "empty_reply"), after[0]
    # …ITS RECOMMENDATIONS, whole — also when the narration WORKED: its
    # recommendations were never stored (the write raised before them), so
    # there is nothing to replace the month's with.
    assert gw.db.rows("recommendations") == first["recommendations"], (
        "%s: the takeover cost the month its recommendations: %r"
        % (second_narration, gw.db.rows("recommendations")))
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A
    # …and the month's ALERTS are the corrected run's: written by the
    # staged run although its briefing write raised, then moved.
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == first["period_id"] and a["document_id"] == replaced["id"]
                          for a in alerts), (
        "%s: the month's alerts are not the corrected run's: %r" % (second_narration, alerts))
    assert sorted(a["alert_key"] for a in body["alerts"]) == sorted(a["alert_key"] for a in alerts)


def test_a_same_month_reupload_whose_narration_works_replaces_the_months_briefing(app, gw, monkeypatch):
    """POSITIVE CONTROL of the takeover law: a blanket "never move the
    briefing" would pass the test above."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), _reply(BODY_B, TITLES_B)])
    first = _first_analysis(app, gw)
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, first["org_id"])

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == first["period_id"] and period["source_document_id"] == replaced["id"]
    (row,) = gw.db.rows("briefings")
    assert row["body"] == BODY_B, "the takeover kept the superseded file's briefing: %r" % row["body"]
    assert row["period_id"] == first["period_id"] and row["org_id"] == first["org_id"]
    assert row["language"] == _language_the_last_narration_was_written_in() == "ro", row["language"]
    assert row["stale_since"] is None and row["stale_reason"] is None
    # No marker was SET by this run — the only marker writes are the clears.
    assert [w["payload"] for w in _marker_updates(spy) if w["payload"].get("stale_reason")] == []
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_B
    _assert_nothing_is_left_under(gw, _staged_period_ids(spy, first["period_id"]), "usable")
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["stale"] is None


@pytest.mark.parametrize("served_text", [
    None,  # the sentinel, exactly as the first (failed) run stored it
    # A row written before the repair: the operator sentence as the briefing.
    "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.",
], ids=["the_sentinel_the_run_stored", "an_operator_sentence_of_before_the_repair"])
def test_a_same_month_reupload_over_an_unusable_briefing_whose_narration_fails_leaves_one_sentinel_row(
        app, gw, monkeypatch, served_text):
    """Served unusable + staged unusable: nothing to keep, nothing to crash
    on — one row, the neutral sentinel, under the month's own period. A
    failure text is never "the last good one": an operator sentence left by
    the old code is replaced, not kept."""
    _script_the_provider(monkeypatch, [RuntimeError(PROVIDER_ERROR_TEXT), RuntimeError(PROVIDER_ERROR_TEXT)])
    first = V._analysed_month(app, gw, V.agras_workbook())
    period_id, org_id = first["period"]["id"], first["doc"]["org_id"]
    (stored,) = gw.db.rows("briefings")
    assert stored["body"] == "[NARRATIVE_UNAVAILABLE]" and stored["period_id"] == period_id, stored
    if served_text is not None:
        stored["body"] = served_text  # database state, as the pre-repair writer left it
    # The state the pre-repair regenerate left in production: a failure
    # text over the briefing, the month's worked recommendations untouched.
    assert gw.db.rows("recommendations") == []
    for title, status in (("Renegociază termenele cu furnizorii", "in_progress"),
                          ("Scurtează termenele de încasare", "new")):
        gw.db.insert("recommendations", [{
            "org_id": org_id, "period_id": period_id, "target_type": "dataset", "target_id": period_id,
            "title": title, "explanation": "…", "urgency": "high", "status": status}], returning=False)
    recommendations_before = copy.deepcopy(gw.db.rows("recommendations"))
    assert len(recommendations_before) == 2
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, org_id)

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == period_id and period["source_document_id"] == replaced["id"]
    rows = gw.db.rows("briefings")
    assert len(rows) == 1, "expected one briefings row, found %r" % rows
    assert rows[0]["body"] == "[NARRATIVE_UNAVAILABLE]" and rows[0]["period_id"] == period_id, rows
    _assert_nothing_is_left_under(gw, _staged_period_ids(spy, period_id), "unusable over unusable")
    # A FAILED narration never costs the month its recommendations,
    # whatever the month's briefing row holds (ruling 2026-10-03).
    assert gw.db.rows("recommendations") == recommendations_before, (
        "the takeover of a failed narration cost the month its recommendations: %r"
        % (gw.db.rows("recommendations"),))
    body = _served_period(app, org_id, period_id)
    assert body["briefing"]["body"] is None and body["briefing"]["unavailable"] is True, body["briefing"]
    assert sorted(r["title"] for r in body["recommendations"]) == \
        ["Renegociază termenele cu furnizorii", "Scurtează termenele de încasare"]


def test_a_same_month_reupload_whose_narration_works_replaces_an_unusable_briefing(app, gw, monkeypatch):
    """THE RECOVERY CELL of the takeover (served unusable + staged usable):
    the month held the sentinel of a failed first analysis; the corrected
    file's narration WORKS — the month now serves it, with its
    recommendations and no marker."""
    _script_the_provider(monkeypatch, [RuntimeError(PROVIDER_ERROR_TEXT), _reply(BODY_B, TITLES_B)])
    first = V._analysed_month(app, gw, V.agras_workbook())
    period_id, org_id = first["period"]["id"], first["doc"]["org_id"]
    (stored,) = gw.db.rows("briefings")
    assert stored["body"] == "[NARRATIVE_UNAVAILABLE]" and stored["period_id"] == period_id, stored
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, org_id)

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == period_id and period["source_document_id"] == replaced["id"]
    (row,) = gw.db.rows("briefings")
    assert row["body"] == BODY_B and row["period_id"] == period_id and row["org_id"] == org_id, row
    assert row["stale_since"] is None and row["stale_reason"] is None, row
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_B
    _assert_nothing_is_left_under(gw, _staged_period_ids(spy, period_id), "recovery")
    body = _served_period(app, org_id, period_id)
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["unavailable"] is False
    assert body["briefing"]["stale"] is None


def _refuse_staged_recommendation_inserts(gw, monkeypatch, served_period_id: str) -> List[Any]:
    """The DATABASE refuses (a transient PostgREST timeout) every
    recommendations insert that is not under the month's own period id —
    i.e. the staged run's. Returns the refused payloads."""
    refused = []  # type: List[Any]
    real = gw.db.insert

    def insert(table: str, rows: Any, *args: Any, **kwargs: Any) -> Any:
        body = rows if isinstance(rows, list) else [rows]
        if table == "recommendations" and any(str(r.get("period_id")) != str(served_period_id) for r in body):
            refused.append(copy.deepcopy(rows))
            raise httpx.ReadTimeout("The read operation timed out")
        return real(table, rows, *args, **kwargs)

    monkeypatch.setattr(gw.db, "insert", insert)
    return refused


_NO_RECOMMENDATIONS_TO_REPLACE_WITH = {
    # The narration WORKED, and its `recommendations` cannot be read: the
    # staged run stored none (W11), and the orchestrator tells the takeover.
    "the_recommendations_cannot_be_read": json.dumps(
        {"briefing": BODY_B, "recommendations": "none"}, ensure_ascii=False),
    # The narration WORKED and is readable, and the DATABASE refused the
    # staged run's recommendations insert: its narrative write raised
    # part-way, and the orchestrator tells the takeover.
    "the_recommendations_write_raised": None,
}  # type: Dict[str, Optional[str]]


@pytest.mark.parametrize("why", sorted(_NO_RECOMMENDATIONS_TO_REPLACE_WITH))
def test_a_same_month_reupload_that_stored_no_recommendations_keeps_the_months_and_takes_the_briefing(
        app, gw, monkeypatch, why):
    """"A takeover must not delete anything that was good" (ruling
    2026-10-03), where the staged narration is USABLE: its briefing
    replaces the month's — and the month's recommendations stay, because
    the run stored none that may replace them. Through the real pipeline:
    the orchestrator's own `keep_recommendations`."""
    reply = _NO_RECOMMENDATIONS_TO_REPLACE_WITH[why] or _reply(BODY_B, TITLES_B)
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), reply])
    first = _first_analysis(app, gw)
    refused = (_refuse_staged_recommendation_inserts(gw, monkeypatch, first["period_id"])
               if why == "the_recommendations_write_raised" else None)
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, first["org_id"])

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    if refused is not None:
        assert len(refused) == 1, "the staged run never tried to insert its recommendations"
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == first["period_id"] and period["source_document_id"] == replaced["id"], period
    # The usable briefing DID replace the month's (the positive control of
    # the keep: a blanket "never move anything" fails here)…
    (row,) = gw.db.rows("briefings")
    assert row["body"] == BODY_B and row["period_id"] == first["period_id"], row
    # …and the month's recommendations are exactly what they were.
    assert gw.db.rows("recommendations") == first["recommendations"], (
        "%s: the takeover cost the month its recommendations: %r" % (why, gw.db.rows("recommendations")))
    _assert_nothing_is_left_under(gw, _staged_period_ids(spy, first["period_id"]), why)
    # The alerts are the corrected run's — written although (in one case)
    # the narrative write raised.
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == first["period_id"] and a["document_id"] == replaced["id"]
                          for a in alerts), alerts
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_B
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A


# ══════════════════════════════════════════════════════════════════════
# W6 — the re-run a USER starts: the Docs panel's "Re-run analysis"
# ══════════════════════════════════════════════════════════════════════
#
# POST /api/pipeline/retry RESETS before it re-runs (it deletes the period
# the document is pinned to; production's foreign keys cascade the briefing
# and the recommendations away) and the run files the document afresh.
# Measured on d3c955a7: with the provider refusing, the reader was served
# `briefing.body: null, unavailable: true` and no recommendations.
#
# RULED 2026-10-03: the re-run must not cost the reader the last good
# briefing or the recommendations. THE RESET STAYS AS IT WAS; what it takes
# is CARRIED across it (`_carry_before_rerun_reset`) and put back by
# `stage_persist_narrative` when the run's narration brings nothing.
#
# (A first repair made the re-run go in place. Independent review measured
# three wrong states of it — a failed re-run left a FAILED document over a
# served period, a failure after persist served new statements beside old
# metrics, a re-filed document kept two periods — and it was withdrawn.
# `test_the_reset_is_what_it_always_was` and
# `test_a_docs_panel_rerun_whose_run_fails_leaves_no_failed_document_over_a_period`
# are the laws that keep it withdrawn.)

#: Production's foreign keys: rows that go with their period (ON DELETE
#: CASCADE — schema_phase3.sql, schema_phase_notes_period_scope.sql).
_PERIOD_CHILD_TABLES = ("statement_line_items", "calculated_metrics", "briefings",
                        "recommendations", "valuations", "alerts")


def _cascade_period_deletes(gw, monkeypatch) -> None:
    """The `gw` double models no foreign key, and the re-run's reset RELIES
    on production's cascade: without it the old period's briefing and
    recommendations would survive here as orphans and nothing below would
    prove that they were CARRIED. Call it before `_Spy` (the child deletes
    are the database's, not the engine's)."""
    real = gw.db.delete

    def delete(table: str, *args: Any, **kwargs: Any) -> Any:
        gone = []  # type: List[str]
        if table == "financial_periods":
            gone = [str(r["id"]) for r in gw.db.select("financial_periods",
                                                       filters=kwargs.get("filters") or {})]
        out = real(table, *args, **kwargs)
        for period_id in gone:
            for child in _PERIOD_CHILD_TABLES:
                real(child, filters={"period_id": "eq.%s" % period_id})
        return out

    monkeypatch.setattr(gw.db, "delete", delete)


#: What a user set on a recommendation — what a reset used to cost them.
WORKED = {"status": "in_review", "owner": "CFO", "due_date": "2026-11-15"}
#: The columns of a recommendation that must come through a re-run untouched.
_REC_COLUMNS = ("id", "org_id", "title", "explanation", "urgency", "status", "owner", "due_date",
                "target_type", "expected_cash_impact_kron", "source_alert_id")


def _work_a_recommendation(gw) -> str:
    """A user works the first recommendation (through the database, as the
    product's own update does). Returns its title."""
    rec = sorted(gw.db.rows("recommendations"), key=lambda r: r["title"])[0]
    gw.db.update("recommendations", dict(WORKED), filters={"id": "eq.%s" % rec["id"]})
    (now,) = [r for r in gw.db.rows("recommendations") if r["id"] == rec["id"]]
    assert dict((k, now[k]) for k in WORKED) == WORKED, now
    return rec["title"]


def _rec_view(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted((dict((k, r.get(k)) for k in _REC_COLUMNS) for r in rows), key=lambda r: r["title"])


def _rerun_world(app, gw, monkeypatch, second: Any) -> Dict[str, Any]:
    """Agras's December analysed with a narration that worked, one
    recommendation worked by a user, the database cascading as production
    does, and the provider scripted for the re-run."""
    monkeypatch.setattr(P, "_RERUN_CARRY", {})
    _cascade_period_deletes(gw, monkeypatch)
    outcomes = [_reply(BODY_A, TITLES_A)] + (second if isinstance(second, list) else [second])
    _script_the_provider(monkeypatch, outcomes)
    first = _first_analysis(app, gw)
    worked_title = _work_a_recommendation(gw)
    return dict(first, worked_title=worked_title,
                recommendations=copy.deepcopy(gw.db.rows("recommendations")))


def _post_retry(app, first: Dict[str, Any]):
    return V._http(app).post("/api/pipeline/retry", headers=V._headers(V.USER, first["org_id"]),
                             json={"document_id": first["doc"]["id"]})


def _docs_panel_rerun(app, gw, first: Dict[str, Any]) -> Dict[str, Any]:
    """What `DocsPanel.tsx` does for a document: the REAL POST
    /api/pipeline/retry, then the run it queued."""
    r = _post_retry(app, first)
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:400])
    return V.run_analysis(gw, first["doc"]["id"])


def _assert_nothing_under(gw, period_id: str) -> None:
    for table in _PERIOD_CHILD_TABLES + ("financial_periods",):
        key = "id" if table == "financial_periods" else "period_id"
        left = [r for r in gw.db.rows(table) if str(r.get(key)) == str(period_id)]
        assert left == [], "%s still holds rows of the reset period %s: %r" % (table, period_id, left[:2])


@pytest.mark.parametrize("migration", _MIGRATION_STATES)
def test_a_docs_panel_rerun_whose_narration_fails_still_serves_the_last_good_briefing(
        app, gw, monkeypatch, migration):
    """THE LAW (the gate sentence, through the entry a USER has): "a failed
    re-run narration keeps the briefing and the recommendations". Both
    states of the stale migration: deploy day is the NOT-applied one."""
    applied = migration == "stale_migration_applied"
    if not applied:
        _before_the_stale_migration(gw)
    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    # The reset happened, as it always did: the document is filed under a
    # period of its own, a NEW row, and nothing is left of the old one.
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == rerun["period_id"] != first["period_id"], period
    assert period["source_document_id"] == first["doc"]["id"]
    _assert_nothing_under(gw, first["period_id"])
    # WHAT THE READER IS SERVED: the last good briefing and recommendations.
    body = _served_period(app, first["org_id"], rerun["period_id"])
    briefing = body["briefing"] or {}
    assert briefing.get("body") == BODY_A and briefing.get("unavailable") is False, (
        "after a Docs-panel re-run whose narration failed the reader is served %r — the last good "
        "briefing is gone" % (body["briefing"],))
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A, body["recommendations"]
    # THE STORED ROWS. One briefing, on the new period: the prose, the
    # language, the model and the definition stamp it had — not this run's.
    (kept,) = gw.db.rows("briefings")
    was = first["briefings"][0]
    assert kept["period_id"] == rerun["period_id"] and kept["org_id"] == first["org_id"]
    for column in ("body", "language", "model", "ebitda_definition"):
        assert kept[column] == was[column], (column, kept[column], was[column])
    # The recommendations as they were — the one a user worked included,
    # with its status, owner and due date — re-keyed to the new period.
    now = gw.db.rows("recommendations")
    assert _rec_view(now) == _rec_view(first["recommendations"]), now
    assert all(r["period_id"] == rerun["period_id"] and r["target_id"] == rerun["period_id"] for r in now)
    (worked,) = [r for r in now if r["title"] == first["worked_title"]]
    assert dict((k, worked[k]) for k in WORKED) == WORKED, worked
    # The run's own alerts, on the new period: the same rules fired (a key
    # that names its period names the new one).
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == rerun["period_id"] for a in alerts), alerts
    assert sorted(a["alert_key"].replace(rerun["period_id"], first["period_id"]) for a in alerts) == \
        first["alert_keys"]
    if applied:
        assert kept["stale_reason"] == "provider_error" and _is_a_timestamp(kept["stale_since"]), kept
        assert briefing["stale"] == {"since": kept["stale_since"], "reason": "provider_error"}
    else:
        # OBSERVED, by D7's design: before the migration nothing durable
        # says the kept briefing is the previous run's. Apply the migration
        # BEFORE the backend is switched (gates.md).
        assert briefing["stale"] is None
    assert P._RERUN_CARRY == {}, "the carry outlived the run that restored it"


def test_a_docs_panel_rerun_whose_narration_works_serves_the_new_briefing(app, gw, monkeypatch):
    """POSITIVE CONTROL of the law above, through the same route: a re-run
    whose narration WORKED serves the NEW briefing and recommendations —
    nothing carried is put back beside them, and the carry is dropped."""
    first = _rerun_world(app, gw, monkeypatch, _reply(BODY_B, TITLES_B))

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], rerun["period_id"])
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["unavailable"] is False, body["briefing"]
    assert body["briefing"]["stale"] is None
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_B
    assert [b["body"] for b in gw.db.rows("briefings")] == [BODY_B]
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_B
    assert P._RERUN_CARRY == {}


def test_the_reset_is_what_it_always_was_and_the_carry_is_taken_before_it(app, gw, monkeypatch):
    """Between POST /api/pipeline/retry and the run: the period IS reset —
    one delete of `financial_periods`, the document and its tenant in the
    filter, the document unpinned and queued — exactly what production
    ran before; and what the reset took is held for the document, read
    BEFORE the delete with the tenant in every filter. (An in-place re-run
    — no delete here — is the withdrawn design.)"""
    first = _rerun_world(app, gw, monkeypatch, [])
    spy = _Spy(gw.db, monkeypatch)
    reads = []  # type: List[Tuple[str, Dict[str, str]]]
    real_select = gw.db.select

    def select(table: str, *args: Any, **kwargs: Any) -> Any:
        if table in ("briefings", "recommendations"):
            reads.append((table, dict(kwargs.get("filters") or {})))
        return real_select(table, *args, **kwargs)

    monkeypatch.setattr(gw.db, "select", select)

    r = _post_retry(app, first)

    assert r.status_code == 202, r.text[:300]
    deletes = [(w["table"], w["filters"]) for w in spy.writes if w["op"] == "delete"]
    assert ("financial_periods", {"id": "eq.%s" % first["period_id"],
                                  "org_id": "eq.%s" % first["org_id"]}) in deletes, deletes
    assert gw.db.rows("financial_periods") == []
    (doc,) = gw.docs(id=first["doc"]["id"])
    assert doc["status"] == "queued" and doc["period_id"] is None and doc["error"] is None, doc
    _assert_nothing_under(gw, first["period_id"])
    # THE CARRY: read with the period AND the tenant, before the delete.
    tenant = {"period_id": "eq.%s" % first["period_id"], "org_id": "eq.%s" % first["org_id"]}
    assert ("briefings", tenant) in reads and ("recommendations", tenant) in reads, reads
    assert all(f == tenant for _t, f in reads), reads
    carry = P._RERUN_CARRY[first["doc"]["id"]]
    assert carry["org_id"] == first["org_id"]
    assert carry["briefing"]["body"] == BODY_A
    assert _rec_view(carry["recommendations"]) == _rec_view(first["recommendations"])


def test_a_docs_panel_rerun_whose_run_fails_leaves_no_failed_document_over_a_period(app, gw, monkeypatch):
    """A re-run whose RUN fails (here the compute stage raises) ends as it
    always did: the document failed and NO period — never a failed document
    over a served month, the state G4 forbids (`empty_live_periods`) and the
    withdrawn in-place design produced. The carry is NOT lost with it: the
    document's NEXT re-run, with the provider still refusing, serves the
    last good briefing and the recommendations again."""
    from engine.workspaces.migration_plan import empty_live_periods

    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    real_compute = P.stage_compute

    def _boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError("compute failed")

    monkeypatch.setattr(P, "stage_compute", _boom)

    failed = _docs_panel_rerun(app, gw, first)

    assert failed["status"] == "failed", (failed["status"], failed.get("error"))
    assert gw.db.rows("financial_periods") == [], gw.db.rows("financial_periods")
    assert empty_live_periods(gw.db.tables) == []
    assert gw.db.rows("briefings") == [] and gw.db.rows("recommendations") == []
    held = P._RERUN_CARRY.get(first["doc"]["id"]) or {}
    assert (held.get("briefing") or {}).get("body") == BODY_A, \
        "a re-run that failed before it narrated lost the carry: %r" % (held,)

    monkeypatch.setattr(P, "stage_compute", real_compute)
    again = _docs_panel_rerun(app, gw, first)

    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    _assert_every_run_reached_the_provider(2)       # the first analysis and this one
    body = _served_period(app, first["org_id"], again["period_id"])
    assert body["briefing"]["body"] == BODY_A, body["briefing"]
    assert _rec_view(gw.db.rows("recommendations")) == _rec_view(first["recommendations"])
    assert P._RERUN_CARRY == {}


def test_a_period_whose_briefing_is_a_failure_text_keeps_its_recommendations_across_a_rerun(
        app, gw, monkeypatch):
    """The state the pre-repair regenerate left in PRODUCTION (measured
    read-only 2026-10-03: 7 of 11 briefings are the sentinel): the briefing
    is a failure text, the recommendations are intact — and worked. The
    carry is not decided on the briefing alone: the recommendations travel
    across the reset whatever the briefing row holds (review, blocker)."""
    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    (stored,) = gw.db.rows("briefings")
    stored["body"] = "[NARRATIVE_UNAVAILABLE]"

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], rerun["period_id"])
    assert body["briefing"]["body"] is None and body["briefing"]["unavailable"] is True, body["briefing"]
    assert [b["body"] for b in gw.db.rows("briefings")] == ["[NARRATIVE_UNAVAILABLE]"]
    now = gw.db.rows("recommendations")
    assert _rec_view(now) == _rec_view(first["recommendations"]), (
        "the re-run cost the period its recommendations: %r" % now)
    assert all(r["period_id"] == rerun["period_id"] for r in now)
    assert P._RERUN_CARRY == {}


@pytest.mark.parametrize("second_narration", ["narration_works", "narration_fails"])
def test_a_docs_panel_rerun_that_files_the_document_under_another_month(app, gw, monkeypatch, second_narration):
    """A re-run can file the document under ANOTHER month than its earlier
    run did (a period detection since corrected). ONE period afterwards, in
    both cases — the document's, under the month the re-run detected; never
    a second month serving the same file (what the withdrawn in-place
    design left when the narration failed)."""
    outcome = _reply(BODY_B, TITLES_B) if second_narration == "narration_works" \
        else RuntimeError(PROVIDER_ERROR_TEXT)
    first = _rerun_world(app, gw, monkeypatch, outcome)
    # Database state: the earlier run had filed the book under December 2024.
    (old,) = gw.db.rows("financial_periods")
    old["period_start"] = old["period_end"] = "2024-12-31"

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == rerun["period_id"] != first["period_id"] and \
        str(period["period_end"]).startswith("2025-12"), period
    body = _served_period(app, first["org_id"], rerun["period_id"])
    if second_narration == "narration_works":
        assert body["briefing"]["body"] == BODY_B
        assert sorted(r["title"] for r in body["recommendations"]) == TITLES_B
    else:
        assert body["briefing"]["body"] == BODY_A and body["briefing"]["unavailable"] is False
        assert _rec_view(gw.db.rows("recommendations")) == _rec_view(first["recommendations"])


def test_a_period_that_cannot_be_read_refuses_the_rerun_and_resets_nothing(app, gw, monkeypatch):
    """The reset never runs blind: when the period's briefing or
    recommendations cannot be read, POST /api/pipeline/retry is refused
    (503 `rerun_unavailable`), nothing is deleted, the month is served as
    it was — and the claim is given back: the same re-run works a moment
    later."""
    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    served_before = _served_period(app, first["org_id"], first["period_id"])
    spy = _Spy(gw.db, monkeypatch)
    real_select = gw.db.select
    down = {"on": True}

    def select(table: str, *args: Any, **kwargs: Any) -> Any:
        if down["on"] and table == "recommendations":
            raise httpx.ReadTimeout("The read operation timed out")
        return real_select(table, *args, **kwargs)

    monkeypatch.setattr(gw.db, "select", select)

    r = _post_retry(app, first)

    assert r.status_code == 503 and r.json() == {"detail": {"code": "rerun_unavailable"}}, (r.status_code, r.text[:300])
    assert [w for w in spy.writes if w["op"] == "delete"] == [], \
        "a refused re-run deleted: %r" % [w for w in spy.writes if w["op"] == "delete"]
    assert [p["id"] for p in gw.db.rows("financial_periods")] == [first["period_id"]]
    down["on"] = False
    assert _served_period(app, first["org_id"], first["period_id"])["briefing"] == served_before["briefing"]
    assert P._RERUN_CARRY == {}
    # POSITIVE CONTROL: the claim was given back — the re-run is accepted now.
    again = _docs_panel_rerun(app, gw, first)
    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    assert _served_period(app, first["org_id"], again["period_id"])["briefing"]["body"] == BODY_A


# ── the carry, at its own seam ─────────────────────────────────────────

NEW_PID = "b1ef0000-0000-4000-8000-0000000000ef"


def _carry_world(body: Optional[str], *, org: str = ORG, recommendations: int = 0) -> RecordingDouble:
    double = RecordingDouble(every_table=True)
    double.add("financial_periods", {"id": PID, "org_id": org, "currency": "RON",
                                     "period_start": "2025-01-01", "period_end": "2025-12-31"})
    if body is not None:
        double.add("briefings", {"id": "briefing-of-the-period", "period_id": PID, "org_id": org,
                                 "body": body, "language": "ro", "model": "the-model-of-the-stored-write"})
    for i in range(recommendations):
        double.add("recommendations", {"id": "rec-%d" % i, "org_id": org, "period_id": PID,
                                       "target_type": "dataset", "target_id": PID,
                                       "title": "Recommendation %d" % i, "status": "new"})
    return double


#: id -> (the stored world, the document the route authorized,
#:        the carried briefing body or None, how many recommendations carried)
_CARRIES = {
    "a_usable_briefing_and_two_recommendations":
        (dict(body=GOOD_BODY, recommendations=2), {"period_id": PID, "org_id": ORG}, GOOD_BODY, 2),
    "a_usable_briefing_and_no_recommendations":
        (dict(body=GOOD_BODY), {"period_id": PID, "org_id": ORG}, GOOD_BODY, 0),
    "the_sentinel_and_two_recommendations":
        (dict(body="[NARRATIVE_UNAVAILABLE]", recommendations=2), {"period_id": PID, "org_id": ORG}, None, 2),
    "the_sentinel_alone": (dict(body="[NARRATIVE_UNAVAILABLE]"), {"period_id": PID, "org_id": ORG}, None, 0),
    "an_operator_sentence_alone": (dict(body="Set ANTHROPIC_API_KEY on the backend to enable AI narrative."),
                                   {"period_id": PID, "org_id": ORG}, None, 0),
    "no_briefing_row": (dict(body=None), {"period_id": PID, "org_id": ORG}, None, 0),
    "a_document_pinned_to_no_period":
        (dict(body=GOOD_BODY, recommendations=2), {"period_id": None, "org_id": ORG}, None, 0),
    # `documents.period_id` is browser-written: a row of ORG carrying a
    # period of ANOTHER tenant that holds a usable briefing and recommendations.
    "another_tenants_period":
        (dict(body=GOOD_BODY, org=OTHER_ORG, recommendations=2), {"period_id": PID, "org_id": ORG}, None, 0),
    "a_document_without_a_tenant":
        (dict(body=GOOD_BODY, recommendations=2), {"period_id": PID, "org_id": ""}, None, 0),
}  # type: Dict[str, Tuple[Dict[str, Any], Dict[str, Any], Optional[str], int]]


@pytest.mark.parametrize("what", sorted(_CARRIES))
def test_the_carry_holds_only_what_the_documents_own_tenant_would_lose(what, monkeypatch):
    world, doc, body, recs = _CARRIES[what]
    monkeypatch.setattr(P, "_RERUN_CARRY", {})
    double = _carry_world(**world)
    with RA.installed(double):
        P._carry_before_rerun_reset(dict(doc, id=DOC_ID))
    assert double.writes == [], "the look wrote: %r" % double.writes
    # Every read it made names the period AND the document's own tenant.
    for table in ("briefings", "recommendations"):
        for _op, _table, filters, _columns in double.selects(table):
            assert filters == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, (table, filters)
    carry = P._RERUN_CARRY.get(DOC_ID)
    if body is None and recs == 0:
        assert carry is None, carry
        return
    assert carry["org_id"] == ORG
    assert (carry["briefing"] or {}).get("body") == body, carry["briefing"]
    assert len(carry["recommendations"]) == recs
    # It is handed back to the tenant it was read in, and to no other.
    assert P._rerun_carry_of(DOC_ID, ORG) is carry
    assert P._rerun_carry_of(DOC_ID, OTHER_ORG) is None
    assert P._rerun_carry_of("another-document", ORG) is None


def test_a_period_with_nothing_to_carry_leaves_an_earlier_carry_in_place(monkeypatch):
    """A re-run that failed before it could narrate left no period: the
    document's next retry finds nothing to read — and must not replace
    what the first one carried with nothing."""
    earlier = {"org_id": ORG, "briefing": {"body": GOOD_BODY, "language": "ro"}, "recommendations": [{"id": "r"}]}
    monkeypatch.setattr(P, "_RERUN_CARRY", {DOC_ID: earlier})
    double = _carry_world(None)
    with RA.installed(double):
        P._carry_before_rerun_reset({"id": DOC_ID, "period_id": PID, "org_id": ORG})
        P._carry_before_rerun_reset({"id": DOC_ID, "period_id": None, "org_id": ORG})
    assert P._RERUN_CARRY == {DOC_ID: earlier}


def test_an_unreadable_period_raises_out_of_the_carry_and_holds_nothing(monkeypatch):
    class _Unreadable(RecordingDouble):
        def select(self, table: str, **kwargs: Any) -> Any:
            if table == "briefings":
                raise httpx.ReadTimeout("The read operation timed out")
            return super(_Unreadable, self).select(table, **kwargs)

    monkeypatch.setattr(P, "_RERUN_CARRY", {})
    double = _Unreadable(every_table=True)
    with RA.installed(double):
        with pytest.raises(httpx.ReadTimeout):
            P._carry_before_rerun_reset({"id": DOC_ID, "period_id": PID, "org_id": ORG})
    assert P._RERUN_CARRY == {}


def test_carried_recommendations_are_put_back_only_on_a_period_that_holds_none(monkeypatch):
    carry = {"org_id": ORG, "briefing": None, "recommendations": [
        {"id": "rec-0", "org_id": ORG, "period_id": PID, "target_type": "dataset", "target_id": PID,
         "title": "About the period", "status": "in_review", "owner": "CFO", "due_date": "2026-11-15"},
        {"id": "rec-1", "org_id": ORG, "period_id": PID, "target_type": "sku", "target_id": "SKU-17",
         "title": "About a SKU", "status": "new"}]}
    double = RecordingDouble(every_table=True)
    double.add("financial_periods", {"id": NEW_PID, "org_id": ORG, "currency": "RON",
                                     "period_start": "2025-01-01", "period_end": "2025-12-31"})
    with RA.installed(double):
        with P._supabase.admin() as client:
            assert P._restore_carried_recommendations(client, carry, ORG, NEW_PID) == 2
            # a second call finds the period holding them: nothing is duplicated
            assert P._restore_carried_recommendations(client, carry, ORG, NEW_PID) == 0
            assert P._restore_carried_recommendations(client, None, ORG, NEW_PID) == 0
    rows = sorted(double.rows("recommendations"), key=lambda r: r["id"])
    assert [(r["id"], r["period_id"], r["target_id"], r["org_id"]) for r in rows] == [
        ("rec-0", NEW_PID, NEW_PID, ORG),          # about the period: re-pointed at the period it is on now
        ("rec-1", NEW_PID, "SKU-17", ORG)]         # about a SKU: its target is its own
    assert (rows[0]["status"], rows[0]["owner"], rows[0]["due_date"]) == ("in_review", "CFO", "2026-11-15")
    # the read that guards against duplicates names the period and the tenant
    assert all(f == {"period_id": "eq.%s" % NEW_PID, "org_id": "eq.%s" % ORG}
               for _op, _t, f, _c in double.selects("recommendations"))


# ══════════════════════════════════════════════════════════════════════
# The findings of the independent review of 2026-10-03, as laws
# ══════════════════════════════════════════════════════════════════════


def _month_alert(alert_id: str, period_id: str, key: str, *, org: str = ORG) -> Dict[str, Any]:
    return {"id": alert_id, "org_id": org, "period_id": period_id, "alert_key": key,
            "severity": "high", "category": "liquidity", "title": key, "body": "…",
            "document_id": FIRST_DOC_ID if period_id == PID else DOC_ID}


def test_a_takeover_whose_staged_period_is_gone_touches_nothing_of_the_month():
    """Measured by the review (experiment X4): the staged row deleted
    during the run (DELETE /api/period, a purge) — the takeover still
    deleted the month's line items, metrics and alerts, moved none,
    archived the month's document and re-pointed the row: an EMPTY month,
    status analysed. Now: no write at all, and the run fails saying so."""
    double = _takeover_world(staged_body=GOOD_BODY, staged_recommendations=True)
    double.add("alerts", _month_alert("alert-of-the-month", PID, "cash_ratio_low"))
    super(RecordingDouble, double).delete("financial_periods", filters={"id": "eq.%s" % STAGED_PID})
    before = dict((t, copy.deepcopy(double.rows(t)))
                  for t in ("financial_periods", "documents", "briefings", "recommendations", "alerts"))
    assert double.writes == []

    with pytest.raises(P.StagedPeriodGone) as refused:
        _take_over(double)

    assert "the month was not replaced" in str(refused.value)
    assert double.writes == [], "the takeover wrote although its staged period was gone: %r" % double.writes
    for table, rows in before.items():
        assert double.rows(table) == rows, "%s changed" % table
    # POSITIVE CONTROL: with the staged row there the same call takes the month over.
    whole = _takeover_world(staged_body=GOOD_BODY, staged_recommendations=True)
    assert _take_over(whole) == PID
    _assert_the_takeover_happened(whole)


@pytest.mark.parametrize("keep_alerts", [True, False], ids=["the_runs_alerts_were_not_written", "the_runs_alerts_were_written"])
def test_a_takeover_keeps_the_months_alerts_when_the_run_wrote_none(keep_alerts):
    """"A takeover must not delete anything that was good": a run whose
    alerts write RAISED has none to move — the month's alerts were deleted
    and replaced by nothing (review, experiment X1: 4 -> 0), which reads as
    "nothing to flag". Told so (`keep_alerts`), the takeover keeps the
    month's. Positive control: alerts the run DID write replace them."""
    double = _takeover_world(staged_body=GOOD_BODY, staged_recommendations=True)
    double.add("alerts", _month_alert("alert-of-the-month-1", PID, "cash_ratio_low"))
    double.add("alerts", _month_alert("alert-of-the-month-2", PID, "leverage_high"))
    double.add("alerts", _month_alert("alert-of-the-other-tenant", OTHER_PID, "theirs", org=OTHER_ORG))
    if not keep_alerts:
        double.add("alerts", _month_alert("alert-of-the-staged-run", STAGED_PID, "margin_thin"))
    foreign_before = [a for a in copy.deepcopy(double.rows("alerts")) if a["org_id"] == OTHER_ORG]

    assert _take_over(double, keep_alerts=keep_alerts) == PID
    _assert_the_takeover_happened(double)

    month = sorted(a["alert_key"] for a in double.rows("alerts") if a["period_id"] == PID)
    if keep_alerts:
        assert month == ["cash_ratio_low", "leverage_high"], month
        # every delete on alerts names the STAGED id and the tenant
        assert [d["filters"] for d in _writes(double, "alerts", "delete")] == [
            {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}]
    else:
        assert month == ["margin_thin"], month
    assert not [a for a in double.rows("alerts") if a["period_id"] == STAGED_PID]
    assert [a for a in double.rows("alerts") if a["org_id"] == OTHER_ORG] == foreign_before


def test_the_takeovers_staged_only_work_comes_before_anything_touches_the_month():
    """The takeover is a sequence, not a transaction. What it deletes under
    the STAGED id is deleted first: a failure there leaves the month whole
    (review, experiment X6: a timeout on the staged recommendations delete
    came AFTER the month's line items, metrics and alerts had been replaced
    — a mixed month under a failed run)."""
    double = _takeover_world(staged_body="[NARRATIVE_UNAVAILABLE]", staged_recommendations=True)
    double.add("alerts", _month_alert("alert-of-the-month", PID, "cash_ratio_low"))
    assert _take_over(double, narration_unavailable="provider_error", keep_alerts=True) == PID
    writes = [w for w in double.writes]
    names_month = [i for i, w in enumerate(writes)
                   if any("eq.%s" % PID == v for v in (w["filters"] or {}).values())
                   or (isinstance(w["payload"], dict) and w["payload"].get("period_id") == PID)]
    staged_only = [i for i, w in enumerate(writes)
                   if w["op"] == "delete" and w["table"] in ("briefings", "recommendations", "alerts")
                   and w["filters"] == {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}]
    assert len(staged_only) == 3 and names_month, (staged_only, names_month)
    assert max(staged_only) < min(names_month), \
        "a staged-only delete came after a write that touches the month: %r" % [
            (w["op"], w["table"], w["filters"]) for w in writes]

    # … and when one of them FAILS, the month is exactly what it was.
    class _StagedDeleteTimesOut(RecordingDouble):
        def delete(self, table: str, *, filters: Dict[str, str]) -> None:
            if table == "recommendations" and filters.get("period_id") == "eq.%s" % STAGED_PID:
                self._attempt("delete", table, filters=filters)["refused"] = True
                raise httpx.ReadTimeout("The read operation timed out")
            return super(_StagedDeleteTimesOut, self).delete(table, filters=filters)

    failing = _StagedDeleteTimesOut(every_table=True)
    source = _takeover_world(staged_body="[NARRATIVE_UNAVAILABLE]", staged_recommendations=True)
    for table in ("financial_periods", "documents", "briefings", "recommendations"):
        for row in source.rows(table):
            failing.add(table, copy.deepcopy(row))
    failing.add("alerts", _month_alert("alert-of-the-month", PID, "cash_ratio_low"))
    month_before = dict((t, copy.deepcopy([r for r in failing.rows(t) if r.get("period_id") == PID
                                           or (t == "financial_periods" and r["id"] == PID)
                                           or t == "documents"]))
                        for t in ("financial_periods", "documents", "briefings", "recommendations", "alerts"))
    with pytest.raises(httpx.ReadTimeout):
        _take_over(failing, narration_unavailable="provider_error", keep_alerts=True)
    for table, rows in month_before.items():
        now = [r for r in failing.rows(table) if r.get("period_id") == PID
               or (table == "financial_periods" and r["id"] == PID) or table == "documents"]
        assert now == rows, "the month's %s changed although the takeover failed on staged-only work" % table


def _refuse_staged_alert_writes(gw, monkeypatch, served_period_id: str) -> List[Any]:
    """The DATABASE refuses (a transient PostgREST timeout) every alerts
    upsert that is not under the month's own period id — i.e. the staged
    run's. Returns the refused payloads."""
    refused = []  # type: List[Any]
    real = gw.db.upsert

    def upsert(table: str, rows: Any, *args: Any, **kwargs: Any) -> Any:
        body = rows if isinstance(rows, list) else [rows]
        if table == "alerts" and any(str(r.get("period_id")) != str(served_period_id) for r in body):
            refused.append(copy.deepcopy(rows))
            raise httpx.ReadTimeout("The read operation timed out")
        return real(table, rows, *args, **kwargs)

    monkeypatch.setattr(gw.db, "upsert", upsert)
    return refused


def test_a_same_month_reupload_whose_alerts_write_fails_takes_the_runs_recommendations_and_keeps_the_months_alerts(
        app, gw, monkeypatch):
    """Measured by the review through the real orchestrator (experiment
    X1): the staged run's narration WORKED, its briefing and its
    recommendations were stored — and the alerts write after them timed
    out. The orchestrator read "the narrative write raised" as "the run
    stored no recommendations": the takeover deleted the run's own good
    recommendation, kept the month's old ones beside the NEW briefing, and
    left the month with no alerts (4 -> 0). The takeover is told what the
    run STORED (`stored`), not whether it raised."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), _reply(BODY_B, TITLES_B)])
    first = _first_analysis(app, gw)
    alerts_before = copy.deepcopy(gw.db.rows("alerts"))
    refused = _refuse_staged_alert_writes(gw, monkeypatch, first["period_id"])
    spy = _Spy(gw.db, monkeypatch)

    replaced = _reupload(app, gw, first["org_id"])

    assert replaced["status"] == "analyzed", (replaced["status"], replaced.get("error"))
    _assert_every_run_reached_the_provider(2)
    assert len(refused) == 1, "the staged run never tried to write its alerts"
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_B, body["briefing"]
    # The run's OWN recommendations — stored before the alerts write raised.
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_B, body["recommendations"]
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == TITLES_B
    # The month's alerts are kept, not replaced by none.
    assert gw.db.rows("alerts") == alerts_before, "the month lost its alerts: %r" % gw.db.rows("alerts")
    _assert_nothing_is_left_under(gw, _staged_period_ids(spy, first["period_id"]), "alerts write failed")


#: The second run's reply -> what the period's recommendations are afterwards.
_REPLIES_AND_THE_RECOMMENDATIONS_AFTER = {
    # A usable reply that does not say `recommendations` at all, or says
    # null: UNREADABLE — the period's worked recommendations stay (review:
    # the narrator coerced both to [] and the writer deleted them, 2 -> 0).
    "the_key_is_absent": (lambda: json.dumps({"briefing": BODY_B}, ensure_ascii=False), TITLES_A),
    "the_value_is_null": (lambda: json.dumps({"briefing": BODY_B, "recommendations": None},
                                             ensure_ascii=False), TITLES_A),
    # POSITIVE CONTROLS: a real list IS the narration's word.
    "an_empty_list": (lambda: json.dumps({"briefing": BODY_B, "recommendations": []},
                                         ensure_ascii=False), []),
    "a_list_of_one": (lambda: _reply(BODY_B, TITLES_B), TITLES_B),
}  # type: Dict[str, Tuple[Callable[[], str], List[str]]]


@pytest.mark.parametrize("reply", sorted(_REPLIES_AND_THE_RECOMMENDATIONS_AFTER))
def test_a_usable_reply_replaces_the_recommendations_only_when_it_carries_a_list(app, gw, monkeypatch, reply):
    """Through the REAL narrator and the REAL writer, on the same period."""
    second, titles_after = _REPLIES_AND_THE_RECOMMENDATIONS_AFTER[reply]
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), second()])
    first = _first_analysis(app, gw)

    rerun = V.run_analysis(gw, first["doc"]["id"])  # the same document, again

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_B, body["briefing"]      # the briefing IS the new one
    assert sorted(r["title"] for r in gw.db.rows("recommendations")) == titles_after, (
        "%s: recommendations after the re-run: %r" % (reply, gw.db.rows("recommendations")))
    if titles_after == TITLES_A:
        assert gw.db.rows("recommendations") == first["recommendations"]


_SKU_RERUNS = {
    "provider_raises": lambda: RuntimeError(PROVIDER_ERROR_TEXT),
    "reply_is_not_json": lambda: REPLY_FRAGMENT,
    "narration_works": lambda: _reply(BODY_B, TITLES_B),
}  # type: Dict[str, Callable[[], Any]]


@pytest.mark.parametrize("second", sorted(_SKU_RERUNS))
def test_a_sales_documents_rerun_through_the_real_orchestrator_keeps_the_sku_briefing_when_its_narration_fails(
        app, gw, monkeypatch, second):
    """THE LINE THAT JOINS THEM. The SKU ruling is gated at the writer
    (`_persist_sku_analysis`) and at the narrator; the orchestrator's own
    `if scope == "sku":` branch — `stage_narrate` -> `_persist_sku_analysis`
    — was driven by no test: a branch that handed the writer the narration
    WITHOUT its `unavailable` code left this whole file green (review
    2026-10-03, one of its plants). Here the real `_run_pipeline_sync` runs a
    document whose scope is `sku`, over a stored usable SKU analysis."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), _SKU_RERUNS[second]()])
    first = _first_analysis(app, gw)
    doc_id, org_id = first["doc"]["id"], first["org_id"]
    gw.db.update("documents", {"scope": "sku"}, filters={"id": "eq.%s" % doc_id})
    gw.db.insert("sku_analyses", {"org_id": org_id, "document_id": doc_id,
                                  "briefing": SKU_GOOD_BRIEFING, "summary": {"sku_count": 405},
                                  "recommendations": copy.deepcopy(SKU_RECOMMENDATIONS),
                                  "language": "en", "model": "the-model-of-the-stored-write"})

    rerun = V.run_analysis(gw, doc_id)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)       # the SKU branch DID narrate
    (row,) = [r for r in gw.db.rows("sku_analyses") if r["document_id"] == doc_id]
    if second == "narration_works":
        # POSITIVE CONTROL: a usable narration replaces the briefing and the
        # recommendations, and is stamped with this run's model.
        assert row["briefing"] == BODY_B, row["briefing"]
        assert [r["title"] for r in row["recommendations"]] == TITLES_B
        assert row["model"] != "the-model-of-the-stored-write"
    else:
        assert row["briefing"] == SKU_GOOD_BRIEFING, (
            "%s: the sales document's re-run stored %r over its briefing" % (second, row["briefing"]))
        assert row["recommendations"] == SKU_RECOMMENDATIONS, row["recommendations"]
        assert row["model"] == "the-model-of-the-stored-write" and row["language"] == "en", row


# ══════════════════════════════════════════════════════════════════════
# The findings of the independent review of 2026-10-04, as laws
# ══════════════════════════════════════════════════════════════════════
#
# Measured on 0340f736, through the real retry route and the real run:
#   · a Docs-panel re-run whose narration WORKED and whose narrative write the
#     database refused once served no recommendations (2 -> 0), or no briefing
#     at all — the carry sat unused in memory (blocker);
#   · the carry was dropped INSIDE the narrative stage: one timeout on the
#     run's last status write rolled back the period it had just been
#     restored on, and nothing was left to restore from (major);
#   · a re-run staged beside another document's month had its carried
#     recommendations deleted "because the month keeps its own" — also when
#     the month held none;
#   · two repaired lines survived mutation with this file green: the
#     takeover's code-based keep decision, and the put-back of the period's
#     previous recommendations.


def _refuse_once(gw, monkeypatch, op: str, table: str, *, land: bool = False) -> List[Any]:
    """The DATABASE refuses the NEXT `op` on `table` — once, as a transient
    PostgREST timeout does — and answers again afterwards. `land`: the write
    IS performed and only its reply is lost (what a read timeout can be).
    Returns the refused payloads."""
    refused = []  # type: List[Any]
    real = getattr(gw.db, op)

    def write(tbl: str, *args: Any, **kwargs: Any) -> Any:
        if tbl == table and not refused:
            refused.append(copy.deepcopy(args[0]) if args else None)
            if land:
                real(tbl, *args, **kwargs)
            raise httpx.ReadTimeout("The read operation timed out")
        return real(tbl, *args, **kwargs)

    monkeypatch.setattr(gw.db, op, write)
    return refused


_REFUSED_NARRATIVE_WRITES = {
    "the_recommendations_insert": ("insert", "recommendations"),
    "the_briefing_upsert": ("upsert", "briefings"),
}  # type: Dict[str, Tuple[str, str]]


@pytest.mark.parametrize("refused_write", sorted(_REFUSED_NARRATIVE_WRITES))
def test_a_docs_panel_rerun_whose_narrative_write_is_refused_still_serves_what_the_reset_took(
        app, gw, monkeypatch, refused_write):
    """THE BLOCKER. The re-run's narration WORKED; the database refused one
    narrative write. The period is new — the reset took the old one — so
    "the period's previous recommendations" are none and nothing on the
    period can be kept: what the period then lacks is put back FROM THE
    CARRY. The reader is never served less than before the click."""
    op, table = _REFUSED_NARRATIVE_WRITES[refused_write]
    first = _rerun_world(app, gw, monkeypatch, _reply(BODY_B, TITLES_B))
    r = _post_retry(app, first)
    assert r.status_code == 202, r.text[:300]
    refused = _refuse_once(gw, monkeypatch, op, table)

    rerun = V.run_analysis(gw, first["doc"]["id"])

    assert refused, "the scenario never happened: no %s on %s was refused" % (op, table)
    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], rerun["period_id"])
    # The recommendations the reset took — the worked one with its status,
    # owner and due date — on the period the document is filed under now.
    now = gw.db.rows("recommendations")
    assert _rec_view(now) == _rec_view(first["recommendations"]), (
        "%s refused: the re-run cost the reader the recommendations: %r" % (refused_write, now))
    assert all(x["period_id"] == rerun["period_id"] and x["target_id"] == rerun["period_id"] for x in now)
    assert sorted(x["title"] for x in body["recommendations"]) == TITLES_A
    (kept,) = gw.db.rows("briefings")
    assert kept["period_id"] == rerun["period_id"] and kept["org_id"] == first["org_id"], kept
    if refused_write == "the_recommendations_insert":
        # The briefing write had landed: the new prose, current.
        assert body["briefing"]["body"] == BODY_B and body["briefing"]["stale"] is None, body["briefing"]
    else:
        # No briefing was stored by the run: the last good one, as it was,
        # and marked — with a reason that is not a narration's failure.
        was = first["briefings"][0]
        for column in ("body", "language", "model", "ebitda_definition"):
            assert kept[column] == was[column], (column, kept[column], was[column])
        assert body["briefing"]["body"] == BODY_A and body["briefing"]["unavailable"] is False
        assert kept["stale_reason"] == "write_refused" and _is_a_timestamp(kept["stale_since"]), kept
        assert kept["stale_reason"] not in P.NARRATION_UNAVAILABLE_CODES
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == rerun["period_id"] for a in alerts), alerts
    assert P._RERUN_CARRY == {}, "the carry outlived the run that put it back"


def test_a_docs_panel_rerun_that_fails_after_the_narrative_stage_keeps_the_carry_for_the_next_run(
        app, gw, monkeypatch):
    """THE CARRY IS LET GO ONLY ONCE THE RUN IS DURABLE. The re-run's
    narration fails, the carry is restored on the new period — and the run's
    LAST write (documents.status = analyzed) times out once. The failure
    handler rolls the period back, the restored briefing and recommendations
    with it. The carry must still be there: the document's next run — POST
    /api/pipeline/run, the entry the Docs panel has for a document that is
    not analysed — serves the last good briefing and the recommendations."""
    first = _rerun_world(app, gw, monkeypatch,
                         [RuntimeError(PROVIDER_ERROR_TEXT), RuntimeError(PROVIDER_ERROR_TEXT)])
    doc_id = first["doc"]["id"]
    real_status = P._admin_set_status
    timed_out = []  # type: List[str]

    def status(document_id: str, value: str, **kwargs: Any) -> None:
        if value == "analyzed" and not timed_out:
            timed_out.append(document_id)
            raise httpx.ReadTimeout("The read operation timed out")
        return real_status(document_id, value, **kwargs)

    monkeypatch.setattr(P, "_admin_set_status", status)

    failed = _docs_panel_rerun(app, gw, first)

    assert timed_out == [doc_id], "the scenario never happened"
    assert failed["status"] == "failed", (failed["status"], failed.get("error"))
    assert gw.db.rows("financial_periods") == [], "a failed run left a period"
    assert gw.db.rows("briefings") == [] and gw.db.rows("recommendations") == []
    held = P._RERUN_CARRY.get(doc_id) or {}
    assert (held.get("briefing") or {}).get("body") == BODY_A and \
        _rec_view(held.get("recommendations") or []) == _rec_view(first["recommendations"]), (
        "a run that failed AFTER the narrative stage lost the carry — the last good briefing "
        "and the worked recommendations are gone for good: %r" % (held,))

    r = V._http(app).post("/api/pipeline/run", headers=V._headers(V.USER, first["org_id"]),
                          json={"document_id": doc_id})
    assert r.status_code in (200, 202) and r.json()["status"] == "queued", (r.status_code, r.text[:400])
    again = V.run_analysis(gw, doc_id)

    assert again["status"] == "analyzed", (again["status"], again.get("error"))
    _assert_every_run_reached_the_provider(3)
    body = _served_period(app, first["org_id"], again["period_id"])
    assert body["briefing"]["body"] == BODY_A and body["briefing"]["unavailable"] is False, body["briefing"]
    now = gw.db.rows("recommendations")
    assert _rec_view(now) == _rec_view(first["recommendations"]), now
    assert all(x["period_id"] == again["period_id"] for x in now)
    assert P._RERUN_CARRY == {}


LEGACY_PID = "c1ea0000-0000-4000-8000-0000000000ea"
LEGACY_DOC = "c1ea0000-0000-4000-8000-0000000000d0"


def test_a_docs_panel_rerun_staged_beside_another_documents_month_keeps_the_carried_recommendations(
        app, gw, monkeypatch):
    """A re-run can be STAGED: another period of the same month exists (a
    legacy duplicate month, another document's). Its narration fails; the
    writer restores the carry under the staged id; the takeover then makes
    the run the month. The month held NO recommendations and no briefing —
    the state of 7 of 11 production periods is close to it — so there was
    nothing of the month's to keep, and the carried rows are MOVED onto it,
    pointing at the period they are on. (They were deleted: 2 -> 0.)"""
    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    (own,) = gw.db.rows("financial_periods")
    # another document's bytes (not a duplicate of this one)
    gw.db.insert("documents", dict(first["doc"], id=LEGACY_DOC, period_id=LEGACY_PID,
                                   content_hash="%064x" % 0xc1ea))
    gw.db.insert("financial_periods", dict(copy.deepcopy(own), id=LEGACY_PID,
                                           source_document_id=LEGACY_DOC))

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == LEGACY_PID == rerun["period_id"] and \
        period["source_document_id"] == first["doc"]["id"], period      # the takeover happened
    now = gw.db.rows("recommendations")
    assert _rec_view(now) == _rec_view(first["recommendations"]), (
        "the takeover deleted the re-run's carried recommendations: %r" % now)
    assert all(x["period_id"] == LEGACY_PID and x["target_id"] == LEGACY_PID for x in now), now
    (worked,) = [x for x in now if x["title"] == first["worked_title"]]
    assert dict((k, worked[k]) for k in WORKED) == WORKED, worked
    (kept,) = gw.db.rows("briefings")
    assert kept["period_id"] == LEGACY_PID and kept["body"] == BODY_A and \
        kept["stale_reason"] == "provider_error", kept
    body = _served_period(app, first["org_id"], LEGACY_PID)
    assert body["briefing"]["body"] == BODY_A and sorted(x["title"] for x in body["recommendations"]) == TITLES_A
    assert P._RERUN_CARRY == {}


CARRIED_BODY = "Briefingul pe care rularea l-a purtat peste resetare: marja s-a menținut."
CARRIED_MARKER = ("2026-09-30T10:00:00+00:00", "provider_error")

_STAGED_USABLE_ROW_AND_A_CODE = {
    # id -> (the month's briefing, whose briefing the month holds afterwards)
    "beside_a_usable_briefing_of_the_month": (GOOD_BODY, "the_months"),
    "beside_a_failure_text": ("[NARRATIVE_UNAVAILABLE]", "the_carried"),
    "beside_no_briefing": (None, "the_carried"),
}  # type: Dict[str, Tuple[Optional[str], str]]


@pytest.mark.parametrize("cell", sorted(_STAGED_USABLE_ROW_AND_A_CODE))
def test_a_run_whose_narration_failed_brought_no_briefing_whatever_row_sits_under_the_staged_id(cell):
    """The ONE input the takeover's `narration_unavailable is not None`
    decides: a USABLE row under the staged id (a re-run's carried briefing,
    restored there by the writer) together with the run's failure code. The
    run narrated nothing — the month's usable briefing is never replaced by
    it; where the month has none, the carried one moves, its marker intact.
    (Mutation `narration_unavailable is not None` -> False left this file
    green, review 2026-10-04.)"""
    served_body, expected = _STAGED_USABLE_ROW_AND_A_CODE[cell]
    double = _takeover_world(staged_body=CARRIED_BODY, served_body=served_body)
    double.update("briefings", {"stale_since": CARRIED_MARKER[0], "stale_reason": CARRIED_MARKER[1]},
                  filters={"period_id": "eq.%s" % STAGED_PID})
    double.writes[:] = []
    month_before = copy.deepcopy(_of_period(double, "briefings"))
    foreign_before = _foreign(double)

    assert _take_over(double, narration_unavailable="unparseable_reply") == PID

    _assert_the_takeover_happened(double)
    (row,) = [b for b in double.rows("briefings") if b["org_id"] == ORG]
    assert row["period_id"] == PID, row
    if expected == "the_months":
        assert _sans_marker(row) == _sans_marker(month_before[0]), (
            "the run's failed narration replaced the month's briefing with the row under the "
            "staged id: %r" % (row,))
        assert row["stale_reason"] == "unparseable_reply" and _is_a_timestamp(row["stale_since"]), row
        (staged_delete,) = _writes(double, "briefings", "delete")
        assert staged_delete["filters"] == {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}
    else:
        assert row["body"] == CARRIED_BODY and row["id"] == "briefing-of-the-staged-run", row
        assert (row["stale_since"], row["stale_reason"]) == CARRIED_MARKER, row
    assert _foreign(double) == foreign_before


@pytest.mark.parametrize("month_holds", ["none", "its_own"])
def test_recommendations_under_the_staged_id_move_onto_a_month_that_holds_none(month_holds):
    """`recommendations_stay` is "the month KEEPS ITS OWN" — a month that
    holds none has nothing to keep, and the rows under the staged id (a
    re-run's carried recommendations) move onto it, their target the period
    they are on. A month that holds its own keeps them and the staged ones
    go (the control — the cell the earlier ruling gated)."""
    double = _takeover_world(staged_body=CARRIED_BODY, staged_recommendations=True)
    if month_holds == "none":
        double.delete("recommendations", filters={"period_id": "eq.%s" % PID})
    double.writes[:] = []
    foreign_before = _foreign(double)

    assert _take_over(double, narration_unavailable="provider_error") == PID

    _assert_the_takeover_happened(double)
    mine = sorted(((r["id"], r["period_id"], r["target_id"])
                   for r in double.rows("recommendations") if r["org_id"] == ORG))
    if month_holds == "none":
        assert mine == [("rec-of-the-staged-run", PID, PID)], (
            "the takeover deleted the recommendations under the staged id although the month "
            "held none: %r" % (mine,))
        assert [w for w in _writes(double, "recommendations", "delete")
                if w["filters"].get("period_id") == "eq.%s" % STAGED_PID] == []
    else:
        assert mine == [("rec-1", PID, PID), ("rec-2", PID, PID)], mine
    assert [r for r in double.rows("recommendations") if r["period_id"] == STAGED_PID] == []
    assert _foreign(double) == foreign_before


class _RefusingOnceDouble(RecordingDouble):
    """`RecordingDouble` whose database times out on the FIRST `insert` into
    `table` only. `land`: that insert is performed and only its reply lost."""

    def __init__(self, table: str, *, land: bool = False, **kwargs: Any) -> None:
        super(_RefusingOnceDouble, self).__init__(**kwargs)
        self.table, self.land, self.refused_once = table, land, False

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        if table == self.table and not self.refused_once:
            self.refused_once = True
            if self.land:
                super(_RefusingOnceDouble, self).insert(table, rows, returning=returning)
            else:
                self.writes.append({"op": "insert", "table": table, "payload": copy.deepcopy(rows),
                                    "filters": {}, "on_conflict": None, "refused": True})
            raise httpx.ReadTimeout("The read operation timed out")
        return super(_RefusingOnceDouble, self).insert(table, rows, returning=returning)


@pytest.mark.parametrize("landed", [False, True], ids=["the_insert_was_refused", "the_insert_landed_and_its_reply_was_lost"])
def test_a_refused_recommendations_insert_puts_the_periods_previous_recommendations_back(monkeypatch, landed):
    """The replacement is a delete then an insert. An insert the database
    refused leaves the period with NONE — its worked recommendations gone
    although the narration had not failed (measured 2 -> 0): they are put
    back, the same rows. A timeout is ambiguous — when the insert LANDED and
    only its reply was lost, the period holds the run's own and the previous
    are NOT put back beside them. Either way the raise reaches the caller,
    the run did not "store its recommendations", and the alerts are written.
    (Mutation `if previous_recs` -> False left this file green.)"""
    narration, _requests = _real_usable_narration(monkeypatch)
    double = _seed_like(_world(), _RefusingOnceDouble("recommendations", land=landed))
    before = copy.deepcopy(_of_period(double, "recommendations"))
    assert len(before) == 2 and before[0]["status"] == "in_progress", before
    foreign_before = _foreign(double)
    stored = {}  # type: Dict[str, bool]

    with RA.installed(double):
        with pytest.raises(httpx.ReadTimeout):
            P.stage_persist_narrative(_doc("ro"), PID, copy.deepcopy(narration),
                                      copy.deepcopy(RUN_ALERTS), stored=stored)

    assert double.refused_once, "the scenario never happened"
    after = _of_period(double, "recommendations")
    if not landed:
        assert sorted(after, key=lambda r: r["id"]) == sorted(before, key=lambda r: r["id"]), (
            "a refused insert cost the period its recommendations: %r" % (after,))
    else:
        assert after and not ({r["id"] for r in after} & {r["id"] for r in before}), (
            "the previous recommendations were put back BESIDE the run's own: %r" % (after,))
    assert "recommendations" not in stored and stored.get("alerts") is True, stored
    _assert_the_runs_alerts_are_stored(double, "recommendations insert refused once")
    assert _foreign(double) == foreign_before


def test_a_kept_row_branch_still_puts_back_recommendations_waiting_in_a_carry(monkeypatch):
    """A carry can outlive the run it was taken for (a restore the database
    refused). A later run on the period whose narration fails KEEPS the
    period's usable briefing — and the recommendations still waiting in the
    carry are put back when the period holds none, before the carry is
    reported settled. (They were dropped with it.)"""
    narration, _code = _real_failed_narration(monkeypatch, "provider_raises")
    double = _world(recommendations=False)
    carried = [{"id": "rec-carried", "org_id": ORG, "period_id": "the-period-the-reset-took",
                "target_type": "dataset", "target_id": "the-period-the-reset-took",
                "title": "Carried", "explanation": "…", "urgency": "high",
                "status": "in_review", "owner": "CFO", "due_date": "2026-11-15"}]
    monkeypatch.setattr(P, "_RERUN_CARRY", {DOC_ID: {"org_id": ORG, "briefing": None,
                                                     "recommendations": copy.deepcopy(carried)}})
    stored = {}  # type: Dict[str, bool]

    with RA.installed(double):
        P.stage_persist_narrative(_doc("ro"), PID, copy.deepcopy(narration),
                                  copy.deepcopy(RUN_ALERTS), stored=stored)

    (row,) = _of_period(double, "recommendations")
    assert (row["id"], row["period_id"], row["target_id"], row["status"], row["owner"]) == \
        ("rec-carried", PID, PID, "in_review", "CFO"), row
    assert stored.get("carry_settled") is True, stored
    # THE STAGE NEVER DROPS THE CARRY: the orchestrator does, once durable.
    assert DOC_ID in P._RERUN_CARRY


def test_the_narrative_stage_reports_the_carry_settled_and_never_drops_it(monkeypatch):
    """At the seam: every exit of `stage_persist_narrative` that used to
    drop the carry now REPORTS it settled and leaves it in place — the
    orchestrator lets it go after the document is marked analysed (the law
    `…fails_after_the_narrative_stage…` is the reason)."""
    carry = {"org_id": ORG, "briefing": {"body": CARRIED_BODY, "language": "ro", "model": "m",
                                         "ebitda_definition": CURRENT_DEFINITION},
             "recommendations": []}
    usable, _requests = _real_usable_narration(monkeypatch)
    failed, _code = _real_failed_narration(monkeypatch, "provider_raises")
    for what, narration, world in (
            ("a usable narration", usable, dict(stored_body=None, recommendations=False)),
            ("a failed narration, the carried briefing restored", failed,
             dict(stored_body=None, recommendations=False)),
            ("a failed narration over a usable row", failed, dict())):
        monkeypatch.setattr(P, "_RERUN_CARRY", {DOC_ID: copy.deepcopy(carry)})
        stored = {}  # type: Dict[str, bool]
        with RA.installed(_world(**world)):
            P.stage_persist_narrative(_doc("ro"), PID, copy.deepcopy(narration),
                                      copy.deepcopy(RUN_ALERTS), stored=stored)
        assert stored.get("carry_settled") is True, (what, stored)
        assert P._RERUN_CARRY == {DOC_ID: carry}, "%s: the stage dropped (or changed) the carry" % what


def test_a_staged_run_whose_period_vanished_fails_plainly_and_the_month_is_served_as_before(
        app, gw, monkeypatch):
    """`StagedPeriodGone`, through the ORCHESTRATOR: a same-month re-upload
    whose staged period is deleted just before the takeover. The run fails
    with the plain sentence (no exception type in front of it), the month
    and its document are what they were, nothing is left under the staged
    id, and GET /api/period still serves the first analysis."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), _reply(BODY_B, TITLES_B)])
    first = _first_analysis(app, gw)
    month_before = copy.deepcopy(first["period"])
    served_before = _served_period(app, first["org_id"], first["period_id"])
    real_takeover = P._finalize_same_month_takeover
    staged_ids = []  # type: List[str]

    def takeover(doc: Dict[str, Any], period_id: str, **kwargs: Any) -> str:
        # The staged period goes away during the run (DELETE /api/period, a purge).
        staged_ids.append(str(period_id))
        for table in _PERIOD_CHILD_TABLES:
            gw.db.delete(table, filters={"period_id": "eq.%s" % period_id})
        gw.db.delete("financial_periods", filters={"id": "eq.%s" % period_id})
        return real_takeover(doc, period_id, **kwargs)

    monkeypatch.setattr(P, "_finalize_same_month_takeover", takeover)

    replaced = _reupload(app, gw, first["org_id"])

    assert staged_ids and staged_ids[0] != first["period_id"], staged_ids
    assert replaced["status"] == "failed", (replaced["status"], replaced.get("error"))
    assert replaced["error"].startswith("The period this run was staged under no longer exists"), \
        replaced["error"]
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == first["period_id"] and \
        period["source_document_id"] == month_before["source_document_id"], period
    (first_doc,) = gw.docs(id=first["doc"]["id"])
    assert first_doc["status"] == "analyzed" and first_doc.get("deleted_at") is None, first_doc
    _assert_nothing_is_left_under(gw, staged_ids, "the staged period vanished")
    after = _served_period(app, first["org_id"], first["period_id"])
    assert after["briefing"] == served_before["briefing"]
    assert sorted(x["title"] for x in after["recommendations"]) == TITLES_A


def test_a_takeover_with_both_periods_gone_refuses_rather_than_pinning_the_document_to_nothing():
    """The staged row is checked BEFORE "the month's row is gone — the
    staged row stands": with both gone the takeover used to return the gone
    id, and the run went on to mark the document analysed on a period that
    does not exist."""
    double = _takeover_world(staged_body=None)
    for period_id in (PID, STAGED_PID):
        double.delete("financial_periods", filters={"id": "eq.%s" % period_id})
    double.writes[:] = []
    with pytest.raises(P.StagedPeriodGone):
        _take_over(double)
    assert double.writes == [], "a refused takeover wrote: %r" % (double.writes,)


def test_a_withheld_narration_carries_a_list_like_every_other_failure(monkeypatch):
    """`stage_narrate`: "a failure result always carries a LIST". The
    numeral guard's withheld narration did not when the reply had no
    `recommendations` key (review 2026-10-04) — the one failure branch whose
    fixture reply happened to carry `[]`."""
    monkeypatch.setitem(_PROVIDER_REPLIES, "numerals_withheld", json.dumps(
        {"briefing": "Revenue was 987,654,321 RON and the margin 77.7%."}))     # no `recommendations` key
    narrated, _code = _real_failed_narration(monkeypatch, "numerals_withheld")
    assert narrated["unavailable"] == "withheld_numerals"
    assert isinstance(narrated["recommendations"], list), narrated


def test_a_usable_sku_reply_whose_recommendations_cannot_be_read_keeps_the_stored_ones(monkeypatch):
    """The SKU writer, the same rule as the period writer: a usable reply
    that OMITS `recommendations` (the narrator hands on None) is not a reply
    that recommends nothing — the briefing is the new one, the stored
    recommendations are kept. Where there is no row to keep, an empty list."""
    narration, _requests = _real_usable_narration(monkeypatch)
    narration = dict(narration, recommendations=None)
    double = _sku_world()
    _persist_sku(double, copy.deepcopy(narration))
    row = _sku_row(double)
    assert row["briefing"] == narration["briefing"], row["briefing"]
    assert row["recommendations"] == SKU_RECOMMENDATIONS, (
        "an unreadable list replaced the stored SKU recommendations: %r" % (row["recommendations"],))
    _assert_the_other_tenants_sku_row_is_untouched(double)

    fresh = _sku_world()
    fresh.delete("sku_analyses", filters={"org_id": "eq.%s" % ORG})     # no row to keep
    _persist_sku(fresh, copy.deepcopy(narration))
    assert _sku_row(fresh)["recommendations"] == []


# ── plants that stayed GREEN in the review of 2026-10-04, closed ──────────

_USABLE_RERUN_REPLIES = {
    # id -> (the re-run's reply, the recommendation titles afterwards, are they the CARRIED rows)
    "an_empty_list_is_the_narrations_word": (
        lambda: json.dumps({"briefing": BODY_B, "recommendations": []}, ensure_ascii=False), [], False),
    "the_key_is_absent": (lambda: json.dumps({"briefing": BODY_B}, ensure_ascii=False), TITLES_A, True),
    "the_value_is_null": (lambda: json.dumps({"briefing": BODY_B, "recommendations": None},
                                             ensure_ascii=False), TITLES_A, True),
}  # type: Dict[str, Tuple[Callable[[], str], List[str], bool]]


@pytest.mark.parametrize("reply", sorted(_USABLE_RERUN_REPLIES))
def test_a_docs_panel_rerun_whose_usable_reply_brings_no_readable_list(app, gw, monkeypatch, reply):
    """Across the RESET (the same-period law above cannot see the carry): a
    usable reply that says `[]` recommends nothing — the carried rows are
    NOT put back beside the new briefing; a reply whose list cannot be read
    replaced nothing — the carried rows ARE the period's, re-keyed."""
    second, titles_after, carried = _USABLE_RERUN_REPLIES[reply]
    first = _rerun_world(app, gw, monkeypatch, second())

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], rerun["period_id"])
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["stale"] is None, body["briefing"]
    now = gw.db.rows("recommendations")
    assert sorted(x["title"] for x in now) == titles_after, (reply, now)
    if carried:
        assert _rec_view(now) == _rec_view(first["recommendations"]), now
        assert all(x["period_id"] == rerun["period_id"] and x["target_id"] == rerun["period_id"] for x in now)
    assert P._RERUN_CARRY == {}


def test_the_restored_briefing_is_the_one_that_was_stored_not_this_runs(app, gw, monkeypatch):
    """"As it was": the model that wrote it, the EBITDA definition it was
    written under (the page hides prose written under an earlier one) and
    the time of its FIRST failure travel with the restored row. In the main
    law the first analysis and the re-run share a model and a definition, so
    a restore that stamped this run's passed it."""
    first = _rerun_world(app, gw, monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    first_failure = "2026-09-30T10:00:00+00:00"
    gw.db.update("briefings", {"model": "the-model-of-the-first-write",
                               "ebitda_definition": PREVIOUS_DEFINITION,
                               "stale_since": first_failure, "stale_reason": "empty_reply"},
                 filters={"period_id": "eq.%s" % first["period_id"]})

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    (kept,) = gw.db.rows("briefings")
    assert kept["period_id"] == rerun["period_id"] and kept["body"] == BODY_A, kept
    assert kept["model"] == "the-model-of-the-first-write", kept["model"]
    assert kept["ebitda_definition"] == PREVIOUS_DEFINITION, kept["ebitda_definition"]
    assert (kept["stale_since"], kept["stale_reason"]) == (first_failure, "provider_error"), kept
    served = _served_period(app, first["org_id"], rerun["period_id"])["briefing"]
    assert served["definition"]["written_under_previous_definition"] is True, served["definition"]
    assert served["stale"] == {"since": first_failure, "reason": "provider_error"}


_EARLIER_CARRY = {"org_id": ORG, "briefing": {"body": CARRIED_BODY, "language": "ro"},
                  "recommendations": [{"id": "rec-earlier", "org_id": ORG, "title": "Earlier"}]}

_CARRY_MERGES = {
    # id -> (the period now, the earlier carry's org, carried body, carried recommendation ids)
    "recommendations_only_keeps_the_earlier_briefing":
        (dict(body="[NARRATIVE_UNAVAILABLE]", recommendations=2), ORG, CARRIED_BODY, ["rec-0", "rec-1"]),
    "a_briefing_only_keeps_the_earlier_recommendations":
        (dict(body=GOOD_BODY), ORG, GOOD_BODY, ["rec-earlier"]),
    "an_earlier_carry_of_another_tenant_is_never_merged_in":
        (dict(body="[NARRATIVE_UNAVAILABLE]", recommendations=2), OTHER_ORG, None, ["rec-0", "rec-1"]),
}  # type: Dict[str, Tuple[Dict[str, Any], str, Optional[str], List[str]]]


@pytest.mark.parametrize("what", sorted(_CARRY_MERGES))
def test_a_new_carry_keeps_what_an_earlier_one_of_the_same_tenant_still_held(what, monkeypatch):
    world, earlier_org, body, rec_ids = _CARRY_MERGES[what]
    monkeypatch.setattr(P, "_RERUN_CARRY", {DOC_ID: dict(copy.deepcopy(_EARLIER_CARRY), org_id=earlier_org)})
    with RA.installed(_carry_world(**world)):
        P._carry_before_rerun_reset({"id": DOC_ID, "period_id": PID, "org_id": ORG})
    carry = P._RERUN_CARRY[DOC_ID]
    assert carry["org_id"] == ORG
    assert (carry["briefing"] or {}).get("body") == body, carry["briefing"]
    assert sorted(r["id"] for r in carry["recommendations"]) == rec_ids, carry["recommendations"]
