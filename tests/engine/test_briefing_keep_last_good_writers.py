"""NO RUN REPLACES A USABLE BRIEFING WITH A FAILED NARRATION — the writers' seam.

Gate `briefing-keep-last-good`, the part that is NOT the regenerate route:
`stage_persist_narrative` (every re-run of an analysed document reaches it on
the SAME period row) and `_finalize_same_month_takeover` (a same-month
re-upload). Hotfix 2 SPEC, decisions D6b, D6c, D7 and the last bullet of D9.

OWNER RULING (2026-10-02, verbatim): "a failed regenerate must NEVER overwrite
a stored briefing with [NARRATIVE_UNAVAILABLE] — keep the last good one, mark
it stale."

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
  W3  A failed narration over a stored failure text stores the sentinel.
      (The period's RECOMMENDATIONS in that state: red, below.)
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
      the served briefing and recommendations intact.
  W7  Through the real pipeline: a same-month re-upload whose narration fails
      replaces the month's statements but not its usable briefing, marks it
      stale with the run's own code, and leaves nothing under the staged id
      (the staged failure text deleted with the tenant in the filter). All
      four cells of served usable/unusable x staged usable/unusable.
  W8  Every failure result of the real `stage_narrate` can be persisted.
  W9  A period that vanished mid-run: no write, no raise.

RED AGAINST THE CODE (2026-10-03, hotfix/entitlement-briefing d3c955a7).
These assert the SPEC and FAIL on the code as it stands. None is skipped or
weakened: each is a defect to repair, or a law for the owner to narrow (the
test is then rewritten to the ruled law).
  R1  The takeover when the staged run left NO briefing row (its
      `stage_persist_narrative` raised — swallowed as non-fatal — or the AI
      lane, which never narrates): the month's usable briefing is DELETED
      and nothing replaces it; the run ends `analyzed`. D6 / D6c.
        test_a_same_month_reupload_whose_staged_briefing_write_fails_…  (pipeline)
        test_a_takeover_whose_staged_run_left_no_briefing_row_…         (seam)
  R2  The Docs panel's "Re-run analysis" (POST /api/pipeline/retry) deletes
      the document's period BEFORE the run: keep-last-good never engages,
      and a failed narration is served as "unavailable" where the last
      good briefing stood. W6 / the gate sentence.
        test_a_docs_panel_rerun_whose_narration_fails_still_serves_…
  R3  A failed narration over a stored FAILURE text (or no briefing row)
      deletes the period's recommendations — the state the pre-repair
      regenerate left in production. The gate sentence is unconditional;
      D6b names only "a usable stored row". OWNER'S RULING.
        test_a_failed_narration_never_deletes_the_periods_recommendations_…
  R4  A USABLE narration whose `recommendations` is not the list of objects
      asked for: briefing replaced, recommendations deleted, a raise, the
      alerts never written — swallowed by the orchestrator. The writer's
      own contract ("alerts … in every case").
        test_a_usable_briefing_with_malformed_recommendations_…
  R5  LATENT (not reachable through the real `stage_narrate` today): what
      the predicate calls unavailable — a dict without `recommendations`,
      a non-dict — makes the writer raise after its destructive writes.
        test_whatever_the_predicate_calls_unavailable_…
  R6  The SKU scope: `_persist_sku_analysis` stores a failed narration over
      a usable `sku_analyses.briefing` and empties its recommendations. D6's
      header ("No writer …"); a/b/c do not name it. OWNER'S RULING.
        test_a_failed_narration_never_replaces_a_usable_sku_briefing

OBSERVED — SPEC SILENT (measured, reported to the owner, NOT asserted).
  · The takeover that KEEPS the month's briefing still deletes the month's
    recommendations (2 before, 0 after — provider raising, a reply that is
    not JSON, an empty reply): `recommendations` is in TAKEOVER_TABLES and
    only `briefings` is skipped. The reader is served the old briefing,
    marked stale, beside zero recommendations. A plain re-run keeps both
    (D6b); D6c names only the briefing.
  · With the stale migration NOT applied, a briefing kept by a failed
    re-run or a failed takeover is served with `stale: null` — nothing
    durable says it is the previous file's prose beside the new numbers
    (D7's "carried by the regenerate response" exists only for the route).
  · R4's recommendations: 2 before, 0 after, whatever the malformed shape.
  · R1 costs the month more than its briefing: the staged run's narrative
    persistence raised before its recommendations and alerts, so the
    takeover moves none — recommendations 2 -> 0, deterministic alerts
    4 -> 0, the document `analyzed`.
  · R2's re-run is unmetered (an analysed document's correction, by
    design) and still calls the provider; it serves 0 recommendations.

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
  · a failure branch of `stage_narrate` dropping a key the writer reads;
  · a write for a period that no longer exists.

CANNOT SEE.
  · PostgREST itself: the real merge-duplicates upsert, the `language in
    ('en','ro')` check, `body not null`, the foreign keys' ON DELETE CASCADE
    (the double models none of them — after POST /api/pipeline/retry the
    old period's briefing survives here as an orphan; production cascades
    it away), or whether the migration is applied in production.
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

PLANT LOG: docs/engine_book/gates.md, "briefing-keep-last-good" — NOT YET
WRITTEN (2026-10-03: neither that section nor the Gate(...) in
scripts/run_battery.py exists; this file's plants are proposed in the
session's report and must be logged there when the gate is registered).
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
    """RED AGAINST THE CODE (2026-10-03, measured: recommendations 2 -> 0).

    The gate sentence (SPEC, "Gates"): "a failed re-run narration keeps the
    briefing and the recommendations" — unconditional. D6b names the
    protection only for "a usable stored row"; the writer follows D6b to
    the letter: it keeps the recommendations only when it keeps the
    briefing (pipeline.py — `kept_row` is set for a usable stored body
    alone), otherwise it falls through to
    `delete("recommendations", period_id=…)` and re-inserts the failed
    narration's empty list.

    This is the production state: the pre-repair regenerate wrote the
    sentinel over the briefing and never touched the recommendations, so
    the first re-run whose narration fails wipes the statuses, owners and
    due dates a user set on them — because a model call failed.

    The usable-row case is W1 above (green); the positive control — a
    narration that WORKED replaces the recommendations — is W4 below.
    OWNER'S RULING NEEDED: fix the writer, or narrow the gate sentence to
    D6b's wording (this test is then rewritten to the ruled law)."""
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
    assert recs[0]["explanation"].startswith("Creanțele se încasează mai lent")
    _assert_the_runs_alerts_are_stored(double, "usable")
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
}  # type: Dict[str, Any]


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
    """RED AGAINST THE CODE (2026-10-03). `stage_persist_narrative`'s own
    contract: "Alerts are deterministic and are written in every case." A
    reply whose `recommendations` is not the list of objects asked for is
    handed on by the real `stage_narrate` as a USABLE narration; the writer
    then replaces the briefing, deletes the period's recommendations and
    raises (TypeError / AttributeError) while it builds the rows — the
    run's alerts are never written, and through the pipeline nobody hears
    of it.

    Asserted: no raise, and the run's alerts stored. What the period's
    recommendations should hold after a malformed list is the owner's to
    rule (measured today: 2 before, 0 after) — it is NOT asserted here."""
    reply = {"briefing": NEW_BODY, "recommendations": _MALFORMED_RECOMMENDATIONS[shape]}
    monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    _install_provider(monkeypatch, lambda _kw: _Reply(json.dumps(reply, ensure_ascii=False)))
    narration = _narrate("ro")
    # PRECONDITION: the real narrator calls this a narration that worked.
    assert narration.get("briefing") == NEW_BODY and not narration.get("unavailable"), (
        "PRECONDITION: stage_narrate must hand %s on as usable: %r" % (shape, narration))
    double = _world()

    raised = _persist_catching(double, narration)

    stored = sorted(a["alert_key"] for a in _of_period(double, "alerts"))
    assert raised is None and stored == RUN_ALERT_KEYS, (
        "recommendations = %s: the writer raised %r after its destructive writes; the alerts stored "
        "are %r (the run's are %r) and the period holds %d recommendation(s)"
        % (shape, raised, stored, RUN_ALERT_KEYS, len(_of_period(double, "recommendations"))))


#: Values the module's own predicate (`narration_unavailable_code`) calls an
#: unavailable narration, which the real `stage_narrate` does not return
#: today (every real failure branch carries both keys — the W8 test above).
_UNAVAILABLE_WITHOUT_RECOMMENDATIONS = {
    "a_coded_failure_with_no_recommendations_key": {"briefing": "x", "unavailable": "no_api_key"},
    "no_result_at_all": None,
}  # type: Dict[str, Any]


@pytest.mark.parametrize("shape", sorted(_UNAVAILABLE_WITHOUT_RECOMMENDATIONS))
def test_whatever_the_predicate_calls_unavailable_the_writer_persists_as_a_first_analysis(shape):
    """RED AGAINST THE CODE (2026-10-03) — LATENT: not reachable through
    the real `stage_narrate` today. The predicate tolerates a non-dict and
    a dict without `recommendations` (it answers a code for both); the
    writer then upserts the sentinel, deletes the period's recommendations
    and raises on `narrate["recommendations"]` — before the alerts.

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


# ══════════════════════════════════════════════════════════════════════
# The takeover at its own seam — a staged run that left NO briefing row
# ══════════════════════════════════════════════════════════════════════

STAGED_PID = "b1ef0000-0000-4000-8000-00000057a6ed"
FIRST_DOC_ID = "doc-of-the-first-upload"


def _takeover_world(*, staged_body: Optional[str]) -> RecordingDouble:
    """The month (PID: a usable briefing, two worked recommendations, the
    first upload's document) and the re-upload's staged period beside it —
    with the briefing row its run stored, or none."""
    double = RecordingDouble(every_table=True)
    double.add("financial_periods", {"id": PID, "org_id": ORG, "currency": "RON",
                                     "source_document_id": FIRST_DOC_ID,
                                     "period_start": "2025-12-01", "period_end": "2025-12-31"})
    double.add("financial_periods", {"id": STAGED_PID, "org_id": ORG, "currency": "RON",
                                     "source_document_id": DOC_ID,
                                     "period_start": "2025-12-01", "period_end": "2025-12-31"})
    for doc_id, period_id in ((FIRST_DOC_ID, PID), (DOC_ID, None)):
        double.add("documents", {"id": doc_id, "org_id": ORG, "status": "analyzed",
                                 "period_id": period_id, "deleted_at": None})
    double.add("briefings", {"id": "briefing-of-the-month", "period_id": PID, "org_id": ORG,
                             "body": GOOD_BODY, "language": "ro", "model": "the-model-of-the-stored-write",
                             "created_at": "2026-09-01T09:00:00+00:00",
                             "ebitda_definition": CURRENT_DEFINITION})
    if staged_body is not None:
        double.add("briefings", {"id": "briefing-of-the-staged-run", "period_id": STAGED_PID,
                                 "org_id": ORG, "body": staged_body, "language": "ro",
                                 "model": "the-model-of-the-staged-write",
                                 "ebitda_definition": CURRENT_DEFINITION})
    for rec_id, status in (("rec-1", "in_progress"), ("rec-2", "new")):
        double.add("recommendations", {"id": rec_id, "org_id": ORG, "period_id": PID,
                                       "target_type": "dataset", "target_id": PID, "title": rec_id,
                                       "explanation": "…", "urgency": "high", "status": status})
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


_NO_STAGED_ROW_CALLS = {
    # The classical lane: `stage_persist_narrative` raised before its upsert
    # (swallowed as non-fatal) and the orchestrator passes the run's code.
    "the_run_says_provider_error": {"narration_unavailable": "provider_error"},
    # The classical lane after a USABLE narration whose write was lost, and
    # the AI lane (pipeline.py — `_finalize_same_month_takeover(doc,
    # period_id)` right after `stage_persist`: that lane never narrates).
    "the_caller_passes_no_code": {},
}  # type: Dict[str, Dict[str, Any]]


@pytest.mark.parametrize("call", sorted(_NO_STAGED_ROW_CALLS))
def test_a_takeover_whose_staged_run_left_no_briefing_row_keeps_the_months_briefing(call):
    """RED AGAINST THE CODE (2026-10-03, measured: briefings [GOOD] -> []).

    SPEC D6: "No writer may replace a usable briefing with an unusable
    one"; D6c: the takeover does not replace the served month's usable
    briefing with a staged one that is unusable. NO staged row is the
    least usable briefing there is (the module's own predicate says so of
    `None`) — and the takeover's keep decision requires a staged row to
    exist (`staged_briefing is not None and …`), ignoring the code its
    caller hands it. So it deletes the month's briefing and moves nothing
    into its place; the run still ends `analyzed`."""
    double = _takeover_world(staged_body=None)
    before = copy.deepcopy(_of_period(double, "briefings"))

    assert _take_over(double, **_NO_STAGED_ROW_CALLS[call]) == PID  # the takeover happened
    (period,) = double.rows("financial_periods")
    assert period["id"] == PID and period["source_document_id"] == DOC_ID, period

    after = _of_period(double, "briefings")
    assert [_sans_marker(r) for r in after] == [_sans_marker(r) for r in before], (
        "%s: the takeover left the month with %d briefing row(s) — its last good briefing is gone "
        "and nothing replaced it" % (call, len(after)))


def test_a_takeover_whose_staged_run_stored_a_usable_briefing_replaces_the_months():
    """POSITIVE CONTROL of the law above at the same seam (a blanket "never
    touch the month's briefing" passes it), and the staged failure text:
    the month's briefing kept, marked with the code the caller passed, the
    staged row deleted with the tenant in the filter."""
    usable = _takeover_world(staged_body=NEW_BODY)
    assert _take_over(usable) == PID
    (row,) = usable.rows("briefings")
    assert row["body"] == NEW_BODY and row["period_id"] == PID and row["org_id"] == ORG, row

    failed = _takeover_world(staged_body="[NARRATIVE_UNAVAILABLE]")
    before = copy.deepcopy(_of_period(failed, "briefings"))
    assert _take_over(failed, narration_unavailable="unparseable_reply") == PID
    (kept,) = failed.rows("briefings")
    assert _sans_marker(kept) == _sans_marker(before[0]), kept
    assert kept["stale_reason"] == "unparseable_reply" and _is_a_timestamp(kept["stale_since"]), kept
    (staged_delete,) = _writes(failed, "briefings", "delete")
    assert staged_delete["filters"] == {"period_id": "eq.%s" % STAGED_PID, "org_id": "eq.%s" % ORG}, \
        "the staged briefing must be deleted with the tenant in the filter: %r" % staged_delete["filters"]


# ══════════════════════════════════════════════════════════════════════
# The SKU scope — `sku_analyses.briefing`, the fourth writer of a briefing
# ══════════════════════════════════════════════════════════════════════

SKU_DOC_ID = "doc-sku-keep-last-good"
SKU_GOOD_BRIEFING = ("Portofoliul este concentrat: primele zece produse aduc două treimi din "
                     "vânzări, iar coada lungă imobilizează stoc.")
SKU_RECOMMENDATIONS = [{"severity": "high", "title": "Delistează produsele cu marjă negativă",
                        "rationale": "Consumă capital fără să aducă marjă.", "actions": ["Stabilește lista"]}]
SKU_PARSED = {"skus": [], "summary": {"sku_count": 406}, "period_label": "2025"}


def _sku_world() -> RecordingDouble:
    double = RecordingDouble(every_table=True)
    double.add("sku_analyses", {"id": "sku-analysis-of-the-document", "org_id": ORG,
                                "document_id": SKU_DOC_ID, "briefing": SKU_GOOD_BRIEFING,
                                "summary": {"sku_count": 406},
                                "recommendations": copy.deepcopy(SKU_RECOMMENDATIONS),
                                "language": "en", "model": "the-model-of-the-stored-write"})
    return double


def _persist_sku(double: RecordingDouble, narration: Dict[str, Any]) -> None:
    """The REAL `_persist_sku_analysis` (what the pipeline's SKU branch
    calls with `stage_narrate`'s result), the database doubled."""
    with RA.installed(double):
        P._persist_sku_analysis({"id": SKU_DOC_ID, "org_id": ORG}, copy.deepcopy(SKU_PARSED), narration)


@pytest.mark.parametrize("branch", ["no_api_key", "provider_raises", "reply_is_not_json"])
def test_a_failed_narration_never_replaces_a_usable_sku_briefing(monkeypatch, branch):
    """RED AGAINST THE CODE (2026-10-03). SPEC D6, its header: "No writer
    may replace a usable briefing with an unusable one." The SKU branch of
    the pipeline hands `stage_narrate`'s result to `_persist_sku_analysis`
    with no predicate: a re-run of a sales document whose narration fails
    stores the operator sentence / the sentinel / the first 500 characters
    of the reply over `sku_analyses.briefing` and replaces its
    recommendations with []. D6 a/b/c do not NAME this writer — the
    owner's call whether the hotfix covers it; the header does."""
    narration, _code = _real_failed_narration(monkeypatch, branch)
    double = _sku_world()

    _persist_sku(double, narration)

    (row,) = double.rows("sku_analyses")
    assert row["briefing"] == SKU_GOOD_BRIEFING, (
        "%s: the stored SKU briefing became %r" % (branch, row["briefing"]))
    assert row["recommendations"] == SKU_RECOMMENDATIONS, (
        "%s: the stored SKU recommendations became %r" % (branch, row["recommendations"]))


def test_a_usable_narration_replaces_the_sku_briefing(monkeypatch):
    """POSITIVE CONTROL of the SKU law: a narration that worked IS written."""
    narration, _requests = _real_usable_narration(monkeypatch)
    double = _sku_world()

    _persist_sku(double, narration)

    (row,) = double.rows("sku_analyses")
    assert row["briefing"] == NEW_BODY and row["org_id"] == ORG, row
    assert [r["title"] for r in row["recommendations"]] == ["Scurtează termenele de încasare"]


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
    # What IS law around the kept briefing: the month's alerts are the
    # corrected run's. (Its recommendations: OBSERVED — SPEC SILENT, in the
    # module docstring; deliberately not asserted.)
    alerts = gw.db.rows("alerts")
    assert alerts and all(a["period_id"] == first["period_id"] and a["document_id"] == replaced["id"]
                          for a in alerts), alerts
    body = _served_period(app, first["org_id"], first["period_id"])
    assert body["briefing"]["body"] == BODY_A and body["briefing"]["unavailable"] is False
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
    """RED AGAINST THE CODE (2026-10-03, measured through the real pipeline:
    status analyzed, briefings [BODY_A] -> [], recommendations 2 -> 0, GET
    /api/period `briefing: null`).

    SPEC D6 / D6c and the gate sentence "the takeover keeps the served
    month's briefing". The staged run's `stage_persist_narrative` raises
    (here: the database times out on its briefing upsert); the orchestrator
    logs it as non-fatal and goes on to the takeover — which finds NO
    staged briefing row, so its keep decision (`staged_briefing is not None
    and …`) is False whatever code the caller passed, and it deletes the
    month's last good briefing with nothing to put in its place. The run
    still ends `analyzed`. Both narrations are driven: one that failed, and
    one that WORKED but whose write was lost — in neither did anything
    usable arrive to replace the month's briefing."""
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
    if second_narration == "narration_fails":
        assert after[0]["stale_reason"] == "provider_error", after[0]


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
    body = _served_period(app, org_id, period_id)
    assert body["briefing"]["body"] is None and body["briefing"]["unavailable"] is True, body["briefing"]


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


# ══════════════════════════════════════════════════════════════════════
# W6 — the re-run a USER starts: the Docs panel's "Re-run analysis"
# ══════════════════════════════════════════════════════════════════════


def _docs_panel_rerun(app, gw, first: Dict[str, Any]) -> Dict[str, Any]:
    """What `DocsPanel.tsx` does for an analysed document: the REAL POST
    /api/pipeline/retry, then the run it queued."""
    doc_id = first["doc"]["id"]
    r = V._http(app).post("/api/pipeline/retry", headers=V._headers(V.USER, first["org_id"]),
                          json={"document_id": doc_id})
    assert r.status_code == 202 and r.json()["status"] == "queued", (r.status_code, r.text[:400])
    return V.run_analysis(gw, doc_id)


def test_a_docs_panel_rerun_whose_narration_fails_still_serves_the_last_good_briefing(app, gw, monkeypatch):
    """RED AGAINST THE CODE (2026-10-03, measured: GET /api/period serves
    `briefing.body: null, unavailable: true` and no recommendations).

    W6 through the entry a USER has: "a failed re-run narration keeps the
    briefing and the recommendations" (the gate sentence). The test above
    re-runs the document on its SAME period row, which is what keep-last-
    good protects. POST /api/pipeline/retry does not get that far:
    `_retry_rerun` DELETES the document's `financial_periods` row before
    the run (production's foreign keys cascade the briefing and the
    recommendations away with it), the run mints a NEW period, the
    narration fails, and `stage_persist_narrative` finds nothing to keep —
    so the reader is served the sentinel as "unavailable" where the last
    good briefing stood. Keep-last-good never engages on the one re-run a
    user can start (production today: the provider refuses every call)."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), RuntimeError(PROVIDER_ERROR_TEXT)])
    first = _first_analysis(app, gw)

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    assert rerun["period_id"], "the re-run document is pinned to no period"
    body = _served_period(app, first["org_id"], rerun["period_id"])
    briefing = body["briefing"] or {}
    assert briefing.get("body") == BODY_A, (
        "after a Docs-panel re-run whose narration failed the reader is served %r — the last good "
        "briefing is gone" % (body["briefing"],))
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_A, body["recommendations"]


def test_a_docs_panel_rerun_whose_narration_works_serves_the_new_briefing(app, gw, monkeypatch):
    """POSITIVE CONTROL of the law above, through the same route: a re-run
    whose narration WORKED serves the new briefing and recommendations."""
    _script_the_provider(monkeypatch, [_reply(BODY_A, TITLES_A), _reply(BODY_B, TITLES_B)])
    first = _first_analysis(app, gw)

    rerun = _docs_panel_rerun(app, gw, first)

    assert rerun["status"] == "analyzed", (rerun["status"], rerun.get("error"))
    _assert_every_run_reached_the_provider(2)
    body = _served_period(app, first["org_id"], rerun["period_id"])
    assert body["briefing"]["body"] == BODY_B and body["briefing"]["unavailable"] is False, body["briefing"]
    assert body["briefing"]["stale"] is None
    assert sorted(r["title"] for r in body["recommendations"]) == TITLES_B
