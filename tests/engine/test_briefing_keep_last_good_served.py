"""GATE briefing-keep-last-good (the SERVED seam) — A FAILED NARRATION IS A
CODE, NEVER A BRIEFING: what the narrator returns, what the two predicates
decide, and what GET /api/period serves.

OWNER RULING (2026-10-02, verbatim): "a failed regenerate must NEVER
overwrite a stored briefing with [NARRATIVE_UNAVAILABLE] — keep the last
good one, mark it stale."

THE DEFECT (measured on the release head before commit 30341f31; real
route, real `stage_narrate`, a provider client that raises — scout map
`specs-durable/hotfix2/scout_briefing.md` §0):

  · `stage_narrate` returned a dict in every failure branch and only ONE of
    them carried anything a program could read: no API key →
    "Set ANTHROPIC_API_KEY on the backend to enable AI narrative."; no SDK →
    "anthropic SDK not installed on backend."; a reply that is not JSON → a
    fragment of the reply; a JSON `null` briefing → `None`, on its way to a
    `body text not null` column; a JSON reply that is not an object raised
    AttributeError and failed the run;
  · every writer stored that text as THE BRIEFING — the regenerate route
    answered 200 `ok: true` and the stored briefing BECAME
    `[NARRATIVE_UNAVAILABLE]` (or the operator sentence);
  · GET /api/period served the stored failure text as `briefing.body`: the
    dashboard mounted an empty card under "AI briefing · verified", the
    report printed `[NARRATIVE_UNAVAILABLE]` as the executive briefing, the
    chat snapshot quoted it as "Prior engine-generated briefing";
  · the server had no predicate at all for "is this a briefing?".

THE LAW (SPEC.md D5, D7, D8 — this file is one of three; the route seam and
the persist / takeover seam are gated by its two siblings):
  S1  the REAL `stage_narrate` returns, in EVERY failure branch,
      `unavailable: <code>` beside its unchanged text and a recommendations
      list, and never raises — not for a reply of any shape, not for an SDK
      that cannot be imported, not for a provider client that cannot be
      constructed, not for a response that carries no readable text; a
      usable reply carries NO code. The same on the SKU call shape (the
      pipeline's `scope == "sku"` branch: `stage_map` then the narrator's
      non-statement prompt), where what it returns is unusable to the
      predicate of S2 — the handle the SKU writer's guard needs.
  S2  `narration_unavailable_code` decides on that code; an unknown code is a
      provider error; a code-less result is usable only if its body is prose.
  S3  `stored_briefing_failure_code` recognises every failure text a writer
      has ever stored — including the fragment of a JSON reply the pre-fix
      not-JSON branch stored as the body (scout §3 `raw_reply_fragment`) —
      and NO prose (a false positive hides a good briefing AND refuses a
      fresh good narration, because S2 falls back to this predicate).
  S4  GET /api/period serves a stored failure text `body: null, unavailable:
      true, unavailable_reason: <code>`; a usable row unchanged, with the
      earlier keys still present; `stale` is `{since, reason}` when the row
      carries the marker and null otherwise; only a row of the PERIOD's own
      workspace is served as its briefing — read with the TENANT in the
      filter (owner ruling 2026-10-03: "the period read without workspace is
      a tenant boundary bug and can't ship").
  S5  round trip through the real routes: a failed regenerate is served
      stale, with the SAME body and a neutral code; a later good one clears it
      — and all of it works BEFORE the migration is applied. The same round
      trip on the pipeline's own writer (`stage_persist_narrative`), and from
      a row that ALREADY holds a failure text (the state of every period
      overwritten before the fix).
      THE ANSWERED `stale` IS TRUTHFUL (owner ruling 2026-10-03: "Never
      report a state that isn't stored"): in every answer of the explicit
      regenerate, `stale` is a boolean equal to what GET /api/period serves
      immediately after the call — true IFF the stored row carries the
      marker then. A failure with nothing usable stored answers false; a
      marker the database refused (the migration not applied) answers false;
      a good write answers false. (SPEC D6a's literal `stale: true` in every
      ok:false answer is superseded by the ruling.)
      WHAT THE NARRATOR USED TO RAISE ON IS A FAILED NARRATION LIKE ANY
      OTHER at the route: 200 `ok: false` with the neutral code, the kept
      body handed back, the reserved message given back to the caller's own
      meter and never committed, nothing written but the marker — never the
      500 those provider states answered before R2 was repaired.
  S6  census: no `upsert("briefings", …)` payload names a stale column, and
      the two column names appear nowhere in src/engine outside the two
      marker writers and the reader; every update / delete AND every select
      on the literal table carries the period and the tenant; the only
      failure text any writer stores is the neutral sentinel; the browser's
      twin of the text predicate (frontend/lib/briefingDefinition.ts) holds
      no phrase searched inside the body.
  S7  the migration adds both columns idempotently and its last executable
      statement reloads the schema cache (CLAUDE.md §14).
  S8  the post-deploy probe — the script's own `probe()`, as it puts the
      request on the wire — posts the EXPLICIT body, so it still reaches
      the verifier.

MEASURED RED AGAINST THE CODE at d3c955a7 — four defects in src/ this file
found in the hotfix's own code, REPAIRED on 2026-10-03 in commit 4828ab7c
(the tests were never weakened, skipped or xfailed; each still reds on its
defect):
  R1  the text predicate's provider regex was searched ANYWHERE in the body
      (pipeline.py `_PROVIDER_ERROR_TEXT_RX` … `.search`): finance prose
      that says "credit balance is too low" was a "provider_error" — a
      stored briefing served `body: null`, and a fresh good narration
      refused by the route (ok: false, the kept row marked stale).
      REPAIR: the pattern is the SDK's own error head ("Error code: N"),
      matched at the START of the body; the bare phrases are gone. The
      browser's twin (frontend/lib/briefingDefinition.ts) carries the same
      predicate.
  R2  `stage_narrate` raised when the provider client could not be
      constructed (`Anthropic(…)` stood outside any try) and when the
      response carried no iterable content / a text block whose text is null
      (the join after the call stood outside it too) — against its own "a
      FAILED narration never raises". REPAIR: the client is constructed
      inside the call's own try (→ `provider_error` beside the sentinel);
      the response is read block by block, text only (→ `empty_reply`).
  R3  a stored body that is a fragment of a JSON reply (begins with `{` or a
      backtick) was prose to both predicates: served as the briefing, and
      handed back as "the briefing that was kept". REPAIR: the text
      predicate names it `unparseable_reply`.
  R4  GET /api/period read `briefings` by `period_id` alone and served
      row [0] — a row another workspace wrote on this period was served to a
      reader whose RLS admits both (older than this hotfix; the regenerate
      route read the same row with the tenant in the filter and answered
      null — the two readers disagreed). REPAIR: the tenant is in the
      filter and re-checked on the row.

THE TRUTHFUL-`stale` LAW IS THE ROUTE's TO KEEP (`regenerate_briefing` and
the two marker writers are the route seam's code, not this seam's). On the
commit that carries this revision ALONE — before the route seam's repair is
merged — the tests below state the ruled law of 2026-10-03 and are red, each
on its `stale` assertion only, against a route that still answers `stale:
true` in every ok:false answer. Measured with a candidate of that repair
applied in the working copy and removed again: all of them green. (The
candidate must not name a stale column inside the route — the census of S6
allows only the two marker writers and the reader; the reader's own
`served_briefing(row)["stale"]` IS "what GET /api/period would serve".)
  · test_a_stored_failure_row_is_never_handed_back_or_marked_and_a_good_regenerate_replaces_it
  · test_a_stored_reply_fragment_is_never_handed_back_as_the_briefing_that_was_kept
  · test_another_workspaces_row_on_this_period_is_never_answered_as_the_kept_briefing
  · test_before_the_migration_is_applied_a_failure_keeps_the_row_and_a_good_narration_still_writes
  · test_a_failed_regenerate_with_nothing_stored_writes_no_row[6 branches]
  · test_the_answered_stale_is_what_get_period_serves_immediately_after
    [before_the_migration | a_stored_failure_text | a_stored_reply_fragment |
     nothing_stored]

WHAT R2 CHANGES OUTSIDE THIS SEAM (independent review of 4828ab7c,
2026-10-03 — three findings, none a change to this seam's source; recorded
here so the merge cannot lose them):
  · THE ROUTE. A response with nothing readable in it, and a client that
    cannot be constructed, no longer leave the narrator as an exception: the
    route answers 200 `ok: false` and gives the unit back (pinned in S5
    through the real route, with the meter on). The route seam's
    `test_a_narrator_that_raises_is_500_and_gives_the_unit_back` drove its
    500 with `content=None` — that input IS R2 — and is red on this seam's
    repair until it makes the narrator raise through something R2 does not
    absorb. The 500 + release + no-write law for such an exception stays
    with the route seam's gate.
  · THE SKU WRITER. Before R2 those two failures failed a SKU run BEFORE
    `_persist_sku_analysis`, so a usable `sku_analyses.briefing` survived
    them by accident; they now reach that writer as a failure dict, and it
    stores `narrative.get("briefing")` with no predicate. Owner ruling (f)
    ("a failed narration never replaces a usable sku_analyses.briefing") is
    the WRITERS seam's repair and gate: THIS SEAM'S REPAIR MUST NOT SHIP
    WITHOUT IT. What this file pins for it: on the SKU call shape the
    narrator returns, for every failure, a dict `narration_unavailable_code`
    names unusable (S1).
  · THE REST OF THE PERIOD READ. GET /api/period still reads
    `calculated_metrics`, `recommendations`, `alerts` and `valuations` by
    `period_id` alone under the caller's RLS — the shape R4 had. MEASURED
    2026-10-03 in this file's world (the reader a member of both
    workspaces, a throwaway probe outside the repository): a
    `recommendations`, an `alerts` and a `calculated_metrics` row carrying
    ANOTHER workspace's org on this period are each served in the payload
    (`valuations` not probed). The coordinator's reading (g) of the owner's
    sentence ("the period read without workspace is a tenant boundary bug
    and can't ship") covers the briefing row, which is what this gate
    tests; the four other reads are the open remainder of that sentence,
    reported for a ticket / the owner's call, not gated here.

WHAT RUNS HERE. The real `create_app()` (the object `python -m engine serve`
runs) with every wall on the request path, real ES256 bearers, the real
`stage_narrate`, the real `stage_persist_narrative`, the real regenerate
route and the real GET /api/period, over the agras corpus book carried
through the production write path. TWO things are doubled and nothing else:
PostgREST (`firm_postgrest_double.PostgrestDouble`, which REFUSES a column no
migration declares — that is how "before the migration is applied" is a
state and not an assumption) and the PROVIDER (a stand-in `anthropic` module
whose client returns a canned reply, returns a response with nothing
readable in it, raises — or cannot be constructed at all). Every expected
string and code below is written out here, never read from the function
under test. No test inherits the ambient environment (`_AMBIENT`).

REDS ON, with the defect repaired (TC-11):
  · a failure branch of `stage_narrate` returning without its code, with a
    different text, or raising — for a reply of any shape (JSON nested
    deeper than the parser follows included), an SDK that cannot be
    imported, a client that cannot be built, or a response with nothing
    readable in it; a reader of the response that drops text it CAN read;
    any of it on the SKU call shape, or a failure there that the predicate
    of S2 would pass as usable;
  · the predicate deciding on body text when a code is present, or passing
    an unknown code through as a reason;
  · a stored failure text the text predicate no longer recognises (it would
    be served as prose again) — or prose it starts to recognise: a provider
    phrase, an "Error code: N", a brace or a backtick in the MIDDLE of a
    sentence included (every failure shape is anchored at the start of the
    body);
  · GET /api/period serving a failure text as `body` (with or without a
    stale marker on the row), dropping one of the earlier keys, serving
    `stale` for a current row, failing on a row that has no stale columns,
    serving another workspace's row as this period's briefing, or reading
    `briefings` without the tenant in the filter;
  · a failed regenerate that changes any stored row beyond the two marker
    columns, or one that is not served stale; a second failure that resets
    `stale_since`; a good one that leaves the marker; a stored failure text
    handed back as "the briefing that was kept" or marked stale; any of it
    depending on the migration having been applied; an answered `stale`
    that is not what GET /api/period serves immediately after the call;
    a provider state R2 absorbs answered 500 by the route again, its
    reserved message committed or left held, or SDK text in the answer;
  · a stale column inside a briefing upsert payload, or named anywhere
    outside the two marker writers and the reader; an update / delete on
    `briefings` without `org_id`; a writer storing provider text, an operator
    sentence or a reply fragment;
  · the migration losing `if not exists`, or its NOTIFY no longer being the
    last EXECUTABLE statement (a commented-out one is not a NOTIFY); the
    deploy probe going back to a body the route's model refuses, or putting
    it on the wire in a form the route does not read as JSON.

CANNOT SEE: the real PostgREST schema cache (a column that exists in
pg_catalog and is still refused — CLAUDE.md §14); the real provider and the
real SDK's response types; RLS (the double has none: a reader here is a
reader whose policies admit every row — which is why the foreign-row law
makes the reader a member of BOTH workspaces); GET /api/period's re-check
of the row's own org AFTER the filtered read (the double honours filters,
so dropping the re-check alone changes nothing here — measured; dropping
the filter, or both, is red); the route's OTHER period-keyed reads
(`calculated_metrics`, `recommendations`, `alerts`, `valuations` by
`period_id` alone — the same shape as R4, outside this gate: see WHAT R2
CHANGES OUTSIDE THIS SEAM); what the SKU WRITER stores
(`_persist_sku_analysis`, `sku_analyses.briefing` — ruling (f), the writers
seam's gate; this file drives the narrator on the SKU call shape and never
that writer);
an exception out of the narrator that R2 does NOT absorb (its prompt is
built before the provider is reached, outside any try — the route's 500
for it is the route seam's law); the meter's own RPCs in Postgres (the S5
meter test records `_usage_gate._rpc`); the `language in ('en','ro')`
check constraint and `unique (period_id)` (the double enforces neither);
rows ALREADY overwritten in production before the fix (one row per period,
no history — there is no last good text to keep); a reply fragment stored
before the fix that does NOT begin with `{` or a backtick ("Here is the
briefing: {…", or the head of a JSON ARRAY — arbitrary text no predicate
can name; a briefing may begin with "["); a body that carries the sentinel
INSIDE longer text (unruled: it is read as a failure text, on both sides);
BEFORE THE MIGRATION IS APPLIED, a briefing kept by ANY failed narration —
a regenerate, a re-run, a takeover: it is served with `stale: null`, the
regenerate route answers `stale: false` (the truth: nothing was stored) and
nothing durable says the prose is older than the figures — SPEC D7 accepts
this ("optional until applied"), so apply the migration BEFORE the backend;
a row that holds a failure text AND carries a marker (no writer of this
hotfix produces it): it is served unavailable, its `stale` is not ruled and
not asserted; the regenerate route's LEGACY answer (it carries no `stale`
here) and a failed NON-RON regenerate (ruled: it marks nothing and answers
the row's existing state — gated with the route seam, where the currency
law lives); a write that names the table through a
VARIABLE (the takeover's `TAKEOVER_TABLES` loop, `delete_period`,
`_period_move` — all older than this change; the call-site censuses read
literal `"briefings"` first arguments only — the stale-column census does
not depend on the call shape); what the frontend does with `unavailable` /
`stale` (gate `briefing-explicit-regenerate`).

NOT FAILURE TEXTS — and, since the repair of R1, PINNED AS PROSE when they
stand inside a sentence: the bare phrases `invalid_request_error`,
`authentication_error`, `credit balance is too low` and an "Error code: N"
that does not begin the body. Every provider text a writer stored begins
with "Narrative unavailable: " (the pre-2026-08-04 branch) or with "Error
code: NNN" (the SDK's own `str(e)`), and those forms ARE pinned as failure
texts. Anchoring the provider pattern to the start of the body is therefore
not a regression of S3.

PLANT LOG: docs/engine_book/gates.md "briefing-keep-last-good".
"""
from __future__ import annotations

import ast
import copy
import importlib.util
import io
import json
import logging
import re
import sys
import types
import urllib.error
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D
from engine.api import _org, _usage_gate
from engine.api import pipeline as P
# Seed data only (a row stamped with TODAY's definition is the one the route
# may hand back as "kept"); never the expected side of an assertion below.
from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION

REPO = Path(__file__).resolve().parents[2]
PIPELINE_PY = REPO / "src" / "engine" / "api" / "pipeline.py"
ENGINE_SRC = REPO / "src" / "engine"
STALE_MIGRATION = REPO / "supabase" / "schema_phase_briefing_stale.sql"
PROBE_SCRIPT = REPO / "scripts" / "check_deployed_routes.py"

USER = "5e2fed00-0000-4000-8000-00000000b21f"
ORG = "0c0f0000-0000-4000-8000-00000000b21f"
OTHER_ORG = "99999999-9999-4999-8999-99999999b21f"
PID = "b21f0000-0000-4000-8000-00000000b21f"
DOC = {"org_id": ORG, "id": "doc-b21f"}

# ── THE EXPECTED STRINGS AND CODES, stated here ───────────────────────────
# Never taken from the module under test: a printer compared with itself
# agrees with its own defect.

SENTINEL = "[NARRATIVE_UNAVAILABLE]"
NO_KEY_SENTENCE = "Set ANTHROPIC_API_KEY on the backend to enable AI narrative."
NO_SDK_SENTENCE = "anthropic SDK not installed on backend."
EMPTY_REPLY_SENTENCE = "Narrative unavailable."
WITHHELD_SENTENCE = ("The briefing was withheld: the model cited figures the engine did "
                     "not author. The statements, ratios and alerts on this page are "
                     "unaffected and remain engine-computed.")
#: The shape of a provider billing refusal (CLAUDE.md §24: "… credit balance
#: is too low") — what the stub client raises, and the kind of text a row
#: written before 2026-08-04 holds behind "Narrative unavailable: ".
PROVIDER_ERROR_TEXT = ("Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', "
                       "'message': 'Your credit balance is too low to access the Anthropic API. "
                       "Please go to Plans & Billing to upgrade or purchase credits.'}}")
#: The six neutral codes of SPEC D5.
CODES = ("no_api_key", "sdk_missing", "provider_error", "unparseable_reply",
         "empty_reply", "withheld_numerals")
STALE_COLUMNS = ("stale_since", "stale_reason")

GOOD = "Agras closed the year with a comfortable liquidity position and a conservative balance sheet."
GOOD_RO = ("Compania a încheiat anul cu o poziție de lichiditate confortabilă, iar marja EBITDA "
           "rămâne peste media sectorului; datoria netă este scăzută și țintele au fost atinse.")
FRESH_RO = ("Marjele s-au menținut, lichiditatea este confortabilă, iar îndatorarea rămâne "
            "prudentă față de capitalurile proprii.")
NOT_JSON_REPLY = "I'm sorry, I can't produce that briefing right now."
NUMERAL_REPLY = "Revenue grew 12% to 110.8M RON and the EBITDA margin reached 9.4%."
#: REAL PROSE that says a provider phrase. "Credit balance" (sold creditor)
#: is the vocabulary of a trial-balance product; a briefing may well say a
#: supplier's is too low. It is a briefing, not an Anthropic billing refusal.
CREDIT_BALANCE_PROSE = ("Trade payables fell during the year, but the supplier's credit balance is too "
                        "low to offset the receivable; liquidity otherwise remains comfortable.")
CREDIT_BALANCE_PROSE_AT_THE_START = ("Credit balance is too low on two supplier accounts to offset the "
                                     "receivable; liquidity otherwise remains comfortable.")
#: What the pre-fix not-JSON branch stored as THE BRIEFING (`text[:500]`):
#: the head of a JSON reply that was cut off, or that carried trailing text.
#: The scout's own count names the shape: left(ltrim(body), 1) in ('{', '`').
TRUNCATED_JSON_FRAGMENT = '{"briefing": "The company posted reven'
#: A usable briefing ANOTHER workspace wrote on this workspace's period (the
#: row carries the writer's own org — the insert policy checks nothing else).
FOREIGN_BRIEFING = {"period_id": PID, "org_id": OTHER_ORG, "body": "Foreign prose of another company.",
                    "language": "en", "model": "claude-test-model",
                    "ebitda_definition": EBITDA_DEFINITION_REVISION}

#: The environment no test of this file may inherit (each sets what it needs
#: on top): the documented local-verification setup exports PUBLIC_TEST_MODE
#: (CLAUDE.md §19), under which a junk bearer is answered by the membership
#: wall and not by the verifier.
_AMBIENT = ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "USAGE_LIMITS_ENABLED", "USAGE_UNMETERED_USER_IDS",
            "AI_NUMERAL_GUARD", "ANTHROPIC_API_KEY")


@pytest.fixture(autouse=True)
def _no_ambient_environment(monkeypatch):
    for name in _AMBIENT:
        monkeypatch.delenv(name, raising=False)


# ── The PROVIDER double (the only thing doubled besides the database) ─────

class _Provider:
    """A stand-in `anthropic` module. `reply` is the text the model answers,
    an exception the client raises, or — a `SimpleNamespace` — the whole
    response object the client returns. Counts constructions and calls."""

    def __init__(self, reply: Any) -> None:
        self.reply = reply
        self.constructed = 0
        self.calls: List[Dict[str, Any]] = []

    def module(self) -> Any:
        provider = self

        class _Messages:
            def create(self, **kwargs: Any) -> Any:
                provider.calls.append(kwargs)
                if isinstance(provider.reply, BaseException):
                    raise provider.reply
                if isinstance(provider.reply, types.SimpleNamespace):
                    return provider.reply
                return types.SimpleNamespace(
                    content=[types.SimpleNamespace(type="text", text=provider.reply)])

        class Anthropic:
            def __init__(self, **_kw: Any) -> None:
                provider.constructed += 1
                self.messages = _Messages()

        return types.SimpleNamespace(Anthropic=Anthropic)


def _install_provider(monkeypatch, reply: Any, *, key: Optional[str] = "test-not-a-key",
                      sdk: bool = True, guard: Optional[str] = None) -> _Provider:
    """Hermetic narrator environment: the key, the SDK, the numeral-guard
    mode, enforcement off — and a meter that fails the test if it is reached
    (no RPC may leave this process)."""
    provider = _Provider(reply)
    if not sdk:
        _app()  # built with the SDK importable: "no SDK" is the narrator's state, not the app's
    if key is None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    else:
        monkeypatch.setenv("ANTHROPIC_API_KEY", key)
    monkeypatch.setitem(sys.modules, "anthropic", provider.module() if sdk else None)
    if guard is None:
        monkeypatch.delenv("AI_NUMERAL_GUARD", raising=False)
    else:
        monkeypatch.setenv("AI_NUMERAL_GUARD", guard)
    for name in ("USAGE_LIMITS_ENABLED", "USAGE_UNMETERED_USER_IDS", "PUBLIC_TEST_MODE", "ENGINE_TEST_MODE"):
        monkeypatch.delenv(name, raising=False)

    def _no_rpc(name: str, *_a: Any, **_k: Any) -> Any:
        raise AssertionError("the meter RPC %r was reached with enforcement off" % name)

    monkeypatch.setattr(_usage_gate, "_rpc", _no_rpc)
    return provider


#: One arrangement per failure branch of `stage_narrate`: (provider kwargs,
#: the code it must return, the text it must return beside it).
BRANCHES: Dict[str, Tuple[Dict[str, Any], str, str]] = {
    "no_api_key": ({"reply": "{}", "key": None}, "no_api_key", NO_KEY_SENTENCE),
    "sdk_missing": ({"reply": "{}", "sdk": False}, "sdk_missing", NO_SDK_SENTENCE),
    "provider_error": ({"reply": RuntimeError(PROVIDER_ERROR_TEXT)}, "provider_error", SENTINEL),
    "unparseable_reply": ({"reply": NOT_JSON_REPLY}, "unparseable_reply", NOT_JSON_REPLY),
    "empty_reply": ({"reply": '{"recommendations": []}'}, "empty_reply", EMPTY_REPLY_SENTENCE),
    "withheld_numerals": ({"reply": json.dumps({"briefing": NUMERAL_REPLY, "recommendations": []}),
                           "guard": "enforce"}, "withheld_numerals", WITHHELD_SENTENCE),
}


def _narrate(doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The REAL `stage_narrate` over the agras book (the production write
    path's own assembly), with whatever provider the test installed."""
    bk = SB.book("agras")
    return P.stage_narrate(dict(doc or bk.doc), copy.deepcopy(bk.persist_assembled), [],
                           {"industry_key": "generic"}, period_id="p-b21f", parsed=bk.parsed)


# ── The world: the real app over the tenancy double ───────────────────────

_APP: Dict[str, Any] = {}


def _app() -> Any:
    if "app" not in _APP:
        _APP["app"] = RA.build_app()
    return _APP["app"]


def _world(*, migration_applied: bool = True,
           briefing: Optional[Dict[str, Any]] = None) -> D.PostgrestDouble:
    """One workspace, its owner, the agras FY2025 period — and `briefing` as
    the period's stored row. `migration_applied=False` is the database
    BEFORE supabase/schema_phase_briefing_stale.sql: the double then refuses
    the two columns exactly as PostgREST does (400, unknown column)."""
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "agras", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book("agras"), PID, ORG, "2025-01-01", "2025-12-31")])
    declared = list(double.columns["briefings"])
    # The "applied" world is only a state if the double learned the columns
    # from the migration file; otherwise every stale assertion is vacuous.
    assert set(STALE_COLUMNS) <= set(declared), declared
    if not migration_applied:
        double.columns["briefings"] = [c for c in declared if c not in STALE_COLUMNS]
    if briefing is not None:
        double.add("briefings", dict({"period_id": PID, "org_id": ORG}, **briefing))
    return double


def _usable_row(body: str = GOOD, **more: Any) -> Dict[str, Any]:
    return dict({"body": body, "language": "en", "model": "claude-test-model",
                 "ebitda_definition": EBITDA_DEFINITION_REVISION}, **more)


def _headers() -> Dict[str, str]:
    return {"Authorization": "Bearer " + D.mint_jwt(USER), "X-Org-Id": ORG}


def _get_period(double: D.PostgrestDouble) -> Dict[str, Any]:
    with RA.installed(double):
        resp = TestClient(_app(), raise_server_exceptions=False).get(
            "/api/period/%s" % PID, headers=_headers())
    assert resp.status_code == 200, resp.text[:400]
    payload = resp.json()
    assert "briefing" in payload, sorted(payload)
    return payload


def _served(double: D.PostgrestDouble) -> Any:
    return _get_period(double)["briefing"]


def _regenerate(double: D.PostgrestDouble, body: Optional[Dict[str, Any]]) -> Any:
    kwargs = {} if body is None else {"json": body}
    with RA.installed(double):
        return TestClient(_app(), raise_server_exceptions=False).post(
            "/api/period/%s/briefing/regenerate" % PID, headers=_headers(), **kwargs)


def _briefing_rows(double: D.PostgrestDouble) -> List[Dict[str, Any]]:
    return double.tables.get("briefings", [])


def _store(double: D.PostgrestDouble) -> Dict[str, List[Dict[str, Any]]]:
    """A deep copy of EVERY stored row of every table. (A table the double
    has only been asked about holds an empty list; that is a read, not a
    row, and is left out.)"""
    return dict((table, copy.deepcopy(rows)) for table, rows in double.tables.items() if rows)


def _without_marker(store: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, Any]]]:
    """`store` with the two marker columns removed from every briefings row
    — what must be byte-identical after a failure that marked the row."""
    out = copy.deepcopy(store)
    for row in out.get("briefings", []):
        for column in STALE_COLUMNS:
            row.pop(column, None)
    return out


# ══ S1 — the real narrator: every failure branch returns its code ═════════

@pytest.mark.parametrize("branch", sorted(BRANCHES))
def test_every_failure_branch_of_the_real_narrator_returns_its_code_beside_its_unchanged_text(
        branch, monkeypatch):
    kwargs, code, text = BRANCHES[branch]
    _install_provider(monkeypatch, **kwargs)
    out = _narrate()
    assert out.get("unavailable") == code, out
    assert out["briefing"] == text, out["briefing"]
    assert out["recommendations"] == [] and isinstance(out["recommendations"], list), out


@pytest.mark.parametrize("key", [None, ""], ids=["unset", "empty"])
def test_without_an_api_key_no_model_is_called(key, monkeypatch):
    provider = _install_provider(monkeypatch, RuntimeError("must not be reached"), key=key)
    out = _narrate()
    assert out.get("unavailable") == "no_api_key", out
    assert out["briefing"] == NO_KEY_SENTENCE
    assert provider.constructed == 0 and provider.calls == []


def test_a_provider_failure_returns_the_sentinel_and_no_provider_text_as_the_briefing(monkeypatch):
    """The battery canary (`floor-valuation`) pins the sentinel; the code is
    what every writer now decides on."""
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    out = _narrate()
    assert len(provider.calls) == 1, "the provider was never asked: the branch under test did not run"
    assert out["briefing"] == SENTINEL
    assert out.get("unavailable") == "provider_error"
    assert "credit balance" not in out["briefing"] and "Error code" not in out["briefing"]
    assert out["recommendations"] == []


#: A reply the model sent that is NOT the object asked for → (code, text).
UNUSABLE_REPLIES = [
    ("not_json", NOT_JSON_REPLY, "unparseable_reply", NOT_JSON_REPLY),
    ("truncated_json", '{"briefing": "Margins held', "unparseable_reply", '{"briefing": "Margins held'),
    ("no_text_at_all", "", "empty_reply", EMPTY_REPLY_SENTENCE),
    ("only_whitespace", "  \n ", "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_without_briefing", '{"recommendations": []}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_null_briefing", '{"briefing": null, "recommendations": null}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_empty_briefing", '{"briefing": ""}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_blank_briefing", '{"briefing": "  \\n "}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_number_briefing", '{"briefing": 42}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_list_briefing", '{"briefing": ["Margins held."]}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_object_briefing", '{"briefing": {"text": "Margins held."}}', "empty_reply", EMPTY_REPLY_SENTENCE),
    ("json_false_briefing", '{"briefing": false}', "empty_reply", EMPTY_REPLY_SENTENCE),
]


@pytest.mark.parametrize("reply,code,text", [c[1:] for c in UNUSABLE_REPLIES],
                         ids=[c[0] for c in UNUSABLE_REPLIES])
def test_a_reply_that_is_not_the_briefing_asked_for_is_coded_and_never_handed_on_as_null(
        reply, code, text, monkeypatch):
    """Measured before the fix: `{"briefing": null}` reached the `body text
    not null` column as None; a missing key stored "Narrative unavailable."
    as the briefing; none carried a code."""
    provider = _install_provider(monkeypatch, reply)
    out = _narrate()
    assert len(provider.calls) == 1
    assert out.get("unavailable") == code, out
    assert out["briefing"] == text, out
    assert isinstance(out["briefing"], str)
    assert out["recommendations"] == []


@pytest.mark.parametrize("reply", ["[1, 2, 3]", '"just a string"', "42", "null", "true",
                                   '[{"briefing": "Margins held."}]'],
                         ids=["list", "string", "number", "null", "true", "list_of_objects"])
def test_a_json_reply_that_is_not_an_object_never_raises_and_is_coded_unusable(reply, monkeypatch):
    """Measured before the fix: `data.get` raised AttributeError and the
    whole run failed.

    ONE code and its text, not an either-or (an either-or leaves the
    branch's return value unasserted). SPEC D5 does not say which of the two
    reply codes a JSON value that is not an object takes; pinned here is the
    mapping of the not-JSON branch next to it — the reply could not be read
    as the object asked for: `unparseable_reply` beside the reply itself.
    (Reported to the owner as a SPEC silence; a ruling for `empty_reply`
    changes the two literals below and nothing else.)"""
    provider = _install_provider(monkeypatch, reply)
    out = _narrate()  # must not raise
    assert len(provider.calls) == 1
    assert out.get("unavailable") == "unparseable_reply", out
    assert out["briefing"] == reply, out
    assert out["recommendations"] == []


def test_a_client_that_cannot_be_constructed_is_a_provider_error_and_never_an_exception(monkeypatch):
    """The provider double above can only fail inside `messages.create`. The
    real SDK also fails at CONSTRUCTION (the httpx `proxies` keyword removal
    and a SOCKS proxy without its extra both raise from `Anthropic(...)`).
    "A FAILED narration never raises" (the narrator's own docstring): the
    pipeline calls it bare, so an exception here fails an analysis whose
    statements and metrics were already replaced, and the regenerate route
    answers 500 where SPEC D6a says 200 `ok: false`."""
    _install_provider(monkeypatch, "{}")
    built: List[List[str]] = []

    class _Unbuildable:
        def __init__(self, **kwargs: Any) -> None:
            built.append(sorted(kwargs))
            raise TypeError("Client.__init__() got an unexpected keyword argument 'proxies'")

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Unbuildable))
    try:
        out = _narrate()
    except Exception as exc:  # noqa: BLE001 — the law is "never raises"
        pytest.fail("stage_narrate RAISED %s(%s) for a provider client that cannot be constructed"
                    % (type(exc).__name__, exc))
    assert len(built) == 1, "the client was never constructed: the branch under test did not run"
    assert out.get("unavailable") == "provider_error", out
    assert out["briefing"] == SENTINEL
    assert out["recommendations"] == []


def test_an_sdk_that_cannot_be_imported_for_any_reason_is_sdk_missing_and_never_an_exception(monkeypatch):
    """`sys.modules["anthropic"] = None` (the `sdk_missing` row of BRANCHES)
    is the SDK not being installed: ImportError. A half-installed or
    version-broken SDK raises something ELSE while it is imported (a
    dependency mismatch surfacing as TypeError / RuntimeError at import).
    Either way there is no SDK to narrate with: the same code beside the
    same sentence, never an exception out of the narrator."""
    _install_provider(monkeypatch, "{}")
    asked: List[str] = []

    class _BrokenSdk(types.ModuleType):
        def __getattr__(self, name: str) -> Any:
            if name != "Anthropic":  # leave dunder probes of the import system alone
                raise AttributeError(name)
            asked.append(name)
            raise RuntimeError("the SDK's dependencies do not match: cannot import %s" % name)

    monkeypatch.setitem(sys.modules, "anthropic", _BrokenSdk("anthropic"))
    try:
        out = _narrate()
    except Exception as exc:  # noqa: BLE001 — the law is "never raises"
        pytest.fail("stage_narrate RAISED %s(%s) for an SDK that cannot be imported"
                    % (type(exc).__name__, exc))
    assert asked == ["Anthropic"], "the import was never attempted: the branch under test did not run"
    assert out.get("unavailable") == "sdk_missing", out
    assert out["briefing"] == NO_SDK_SENTENCE
    assert out["recommendations"] == []


def test_a_reply_nested_deeper_than_the_parser_follows_is_unparseable_and_never_an_exception(monkeypatch):
    """`json.loads` does not answer JSONDecodeError for every text it cannot
    read: brackets nested past the interpreter's recursion limit raise
    RecursionError. It is a reply that is not the object asked for — the
    not-JSON branch's code beside the head of the reply, never an exception
    out of the narrator."""
    reply = "[" * 100000 + "]" * 100000
    with pytest.raises(RecursionError):  # the precondition, stated: this interpreter cannot parse it
        json.loads(reply)
    provider = _install_provider(monkeypatch, reply)
    try:
        out = _narrate()
    except RecursionError as exc:
        pytest.fail("stage_narrate RAISED RecursionError(%s) for a deeply nested reply" % exc)
    assert len(provider.calls) == 1
    assert out.get("unavailable") == "unparseable_reply", out.get("unavailable")
    assert out["briefing"] == "[" * 500
    assert out["recommendations"] == []


def _response(content: Any) -> Any:
    return types.SimpleNamespace(content=content)


#: A provider call that SUCCEEDED and whose response carries no readable
#: text. The first two never raised (positive controls: the table is not a
#: list of shapes the narrator rejects wholesale); `content_is_null` and
#: `a_text_block_whose_text_is_null` raised TypeError from the join that
#: stood outside any try (R2); the last three are the same law for the
#: neighbouring shapes.
TEXTLESS_RESPONSES = [
    ("no_content_blocks", lambda: _response([])),
    ("only_a_non_text_block", lambda: _response(
        [types.SimpleNamespace(type="tool_use", id="toolu_b21f", name="noop", input={})])),
    ("content_is_null", lambda: _response(None)),
    ("a_text_block_whose_text_is_null", lambda: _response([types.SimpleNamespace(type="text", text=None)])),
    ("content_is_not_iterable", lambda: _response(42)),
    ("a_text_block_whose_text_is_a_number", lambda: _response([types.SimpleNamespace(type="text", text=42)])),
    ("a_null_block", lambda: _response([None])),
]


@pytest.mark.parametrize("build", [c[1] for c in TEXTLESS_RESPONSES], ids=[c[0] for c in TEXTLESS_RESPONSES])
def test_a_response_that_carries_no_readable_text_is_an_empty_reply_and_never_an_exception(
        build, monkeypatch):
    """The same law as the `no_text_at_all` row above ("" → `empty_reply`
    beside "Narrative unavailable."), for the response SHAPES that reach the
    join after the call: the provider answered, and there is nothing to
    read."""
    provider = _install_provider(monkeypatch, build())
    try:
        out = _narrate()
    except Exception as exc:  # noqa: BLE001 — the law is "never raises"
        pytest.fail("stage_narrate RAISED %s(%s) for a response with no readable text"
                    % (type(exc).__name__, exc))
    assert len(provider.calls) == 1
    assert out.get("unavailable") == "empty_reply", out
    assert out["briefing"] == EMPTY_REPLY_SENTENCE
    assert out["recommendations"] == []


def test_the_text_of_a_response_is_read_across_its_text_blocks_and_from_nothing_else(monkeypatch):
    """The positive control of the table above (a reader that answered ""
    for every response would pass it): the reply is the TEXT blocks, joined
    in order — a block that is not text is not read even when it carries a
    `text` attribute, and a text block with nothing readable in it does not
    cost the response its other blocks."""
    provider = _install_provider(monkeypatch, _response([
        types.SimpleNamespace(type="thinking", thinking="…", text="NOT THE REPLY "),
        types.SimpleNamespace(type="text", text='{"briefing": "Margins '),
        types.SimpleNamespace(type="text", text=None),
        types.SimpleNamespace(type="tool_use", id="toolu_b21f", name="noop", input={}),
        types.SimpleNamespace(type="text", text='held.", "recommendations": []}'),
    ]))
    out = _narrate()
    assert len(provider.calls) == 1
    assert "unavailable" not in out, out
    assert out["briefing"] == "Margins held."
    assert out["recommendations"] == []


def test_enforce_mode_withholding_the_briefing_is_coded_and_observe_mode_is_not(monkeypatch):
    reply = json.dumps({"briefing": NUMERAL_REPLY, "recommendations": []})
    _install_provider(monkeypatch, reply, guard="enforce")
    withheld = _narrate()
    assert withheld.get("unavailable") == "withheld_numerals", withheld
    assert withheld["briefing"] == WITHHELD_SENTENCE
    assert "110.8M" not in withheld["briefing"]
    # Positive controls: the SAME reply under the default mode is a briefing,
    # and digit-free prose under enforce is one too.
    _install_provider(monkeypatch, reply, guard=None)
    observed = _narrate()
    assert "unavailable" not in observed and observed["briefing"] == NUMERAL_REPLY, observed
    _install_provider(monkeypatch, json.dumps({"briefing": GOOD, "recommendations": []}), guard="enforce")
    clean = _narrate()
    assert "unavailable" not in clean and clean["briefing"] == GOOD, clean


USABLE_REPLIES = [
    ("plain", json.dumps({"briefing": GOOD, "recommendations": []}), GOOD),
    ("romanian", json.dumps({"briefing": GOOD_RO, "recommendations": []}, ensure_ascii=False), GOOD_RO),
    ("with_figures", json.dumps({"briefing": NUMERAL_REPLY}), NUMERAL_REPLY),
    ("fenced", "```json\n%s\n```" % json.dumps({"briefing": GOOD, "recommendations": []}), GOOD),
    ("says_unavailable_mid_sentence",
     json.dumps({"briefing": "Debt/EBITDA is unavailable because EBITDA is negative; liquidity is strong."}),
     "Debt/EBITDA is unavailable because EBITDA is negative; liquidity is strong."),
    # The narrator itself does not code this reply (green today): what refuses
    # it is the text predicate one step later — see R1 and the tests of S2,
    # S3, S4 and S5 that carry the same sentence.
    ("says_a_credit_balance_is_too_low", json.dumps({"briefing": CREDIT_BALANCE_PROSE}), CREDIT_BALANCE_PROSE),
]


@pytest.mark.parametrize("reply,body", [c[1:] for c in USABLE_REPLIES], ids=[c[0] for c in USABLE_REPLIES])
def test_a_usable_reply_carries_no_unavailable_key(reply, body, monkeypatch):
    """The positive control of every law above: a narrator that coded every
    result unusable would pass them all."""
    provider = _install_provider(monkeypatch, reply)
    out = _narrate()
    assert len(provider.calls) == 1
    assert "unavailable" not in out, out
    assert out["briefing"] == body
    assert isinstance(out["recommendations"], list)


def test_the_recommendations_of_a_usable_reply_pass_through(monkeypatch):
    rec = {"severity": "high", "category": "financial", "title": "Build a liquidity buffer",
           "rationale": "Cash covers a thin share of short-term liabilities.",
           "actions": ["Agree a committed facility"], "estimated_ron_impact": None,
           "metric_referenced": "cash_ratio"}
    _install_provider(monkeypatch, json.dumps({"briefing": GOOD, "recommendations": [rec]}))
    out = _narrate()
    assert "unavailable" not in out
    assert out["recommendations"] == [rec]


# ── R2, as an arrangement the SKU call shape and the route can both meet ───

def _install_unbuildable_client(monkeypatch) -> List[List[str]]:
    """The SDK imports and its client cannot be CONSTRUCTED (what the httpx
    `proxies` removal did to every deployed SDK of its day). Returns the
    record of construction attempts — the proof the branch ran."""
    built: List[List[str]] = []

    class _Unbuildable:
        def __init__(self, **kwargs: Any) -> None:
            built.append(sorted(kwargs))
            raise TypeError("Client.__init__() got an unexpected keyword argument 'proxies'")

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Unbuildable))
    return built


#: The provider states `stage_narrate` RAISED on before R2 was repaired:
#: (id, the response the provider returns — or None for a client that cannot
#: be constructed —, the code, the text beside it). Until the repair each of
#: them left the narrator as an exception: the pipeline failed the run (on
#: the SKU branch BEFORE its writer was reached) and the regenerate route
#: answered 500.
R2_STATES = [
    ("a_client_that_cannot_be_constructed", None, "provider_error", SENTINEL),
    ("a_response_whose_content_is_null", lambda: _response(None), "empty_reply", EMPTY_REPLY_SENTENCE),
    ("a_text_block_whose_text_is_null",
     lambda: _response([types.SimpleNamespace(type="text", text=None)]), "empty_reply", EMPTY_REPLY_SENTENCE),
]


def _arrange_r2(monkeypatch, response: Any) -> Any:
    """Install one state of R2_STATES; returns a callable answering how many
    times the provider was REACHED (constructed, for the client that cannot
    be built; called, for a response) — 0 means the path under test did not
    run."""
    if response is None:
        _install_provider(monkeypatch, "{}")
        built = _install_unbuildable_client(monkeypatch)
        return lambda: len(built)
    provider = _install_provider(monkeypatch, response())
    return lambda: len(provider.calls)


# ── the SKU call shape (the pipeline's `scope == "sku"` branch) ───────────
#
# Review of 2026-10-03: R2 changed what reaches the SKU writer. A client
# that could not be constructed, or a response with nothing readable in it,
# used to RAISE out of the narrator — the SKU run failed before
# `_persist_sku_analysis` and the stored `sku_analyses.briefing` survived by
# accident. Both now come back as a failure dict, and that writer stores
# `narrative.get("briefing")` with no predicate (owner ruling (f): "a failed
# narration never replaces a usable sku_analyses.briefing" — the WRITERS
# seam's repair and gate). What THIS seam owes that repair is pinned here:
# on the SKU call shape too the narrator never raises, and what it returns
# is unusable to the predicate every writer decides on — so one guard on
# `narration_unavailable_code` at the SKU writer covers every failure.

SKU_DOC = {"org_id": ORG, "id": "doc-sku-b21f", "original_filename": "vanzari_2025.xlsx",
           "detected_language": "en"}
#: A parsed SALES document: no accounts, so the narrator takes its
#: non-statement prompt — the mode no other test of this file runs.
SKU_PARSED = {
    "detected_type": "sales_analysis",
    "period_label": "FY2025",
    "summary": {"row_count": 2, "headline_total": 1200.0,
                "top_records": [{"sku": "A-100", "revenue": 700.0}]},
    "skus": [{"sku": "A-100", "revenue": 700.0}, {"sku": "B-200", "revenue": 500.0}],
}
#: How each narrator prompt begins — written out here, so a test can tell
#: WHICH mode ran from what the provider was sent.
NON_STATEMENT_PROMPT_HEAD = "You are a senior CFO advisor reviewing a business document."
STATEMENT_PROMPT_HEAD = "You are a senior CFO advising the management team of a European SME."


def _narrate_sku() -> Dict[str, Any]:
    """The SKU branch's own two calls, both REAL and in its own shape
    (pipeline.py, `if scope == "sku":`): `stage_map` over the parsed sales
    document, then `stage_narrate` with no metrics and `period_id="-"`."""
    parsed = copy.deepcopy(SKU_PARSED)
    assembled = P.stage_map(dict(SKU_DOC), parsed, "generic")
    return P.stage_narrate(dict(SKU_DOC), assembled, [], {"industry_key": "generic"},
                           period_id="-", parsed=parsed)


def test_the_sku_call_shape_runs_the_non_statement_prompt_and_a_usable_reply_is_usable(monkeypatch):
    """The positive control of the two SKU tables below: `_narrate_sku` runs
    the narrator in the mode the SKU branch runs it in (not the statement
    mode every other test here uses), and in that mode a good reply is a
    briefing — no code, usable to the predicate."""
    provider = _install_provider(monkeypatch, json.dumps({"briefing": GOOD, "recommendations": []}))
    out = _narrate_sku()
    assert len(provider.calls) == 1
    assert provider.calls[0]["system"].startswith(NON_STATEMENT_PROMPT_HEAD), provider.calls[0]["system"][:80]
    assert "unavailable" not in out, out
    assert out["briefing"] == GOOD
    assert P.narration_unavailable_code(out) is None
    # …and the head tells the two modes apart: the statement book of this
    # file is narrated under the OTHER prompt.
    _narrate()
    assert len(provider.calls) == 2
    assert provider.calls[1]["system"].startswith(STATEMENT_PROMPT_HEAD), provider.calls[1]["system"][:80]


@pytest.mark.parametrize("branch", sorted(BRANCHES))
def test_on_the_sku_call_shape_every_failure_branch_returns_its_code_beside_its_text(branch, monkeypatch):
    """S1 on the mode the SKU writer is fed from. Measured before the hotfix
    through that writer: the operator sentence, or the first 500 characters
    of a raw reply, stored as `sku_analyses.briefing` — the narrator handed
    them over with nothing a program could read."""
    kwargs, code, text = BRANCHES[branch]
    _install_provider(monkeypatch, **kwargs)
    out = _narrate_sku()
    assert out.get("unavailable") == code, out
    assert out["briefing"] == text, out["briefing"]
    assert out["recommendations"] == [] and isinstance(out["recommendations"], list), out
    assert P.narration_unavailable_code(out) == code


@pytest.mark.parametrize("response,code,text", [c[1:] for c in R2_STATES], ids=[c[0] for c in R2_STATES])
def test_on_the_sku_call_shape_what_the_narrator_used_to_raise_on_is_a_coded_failure(
        response, code, text, monkeypatch):
    """R2 on the SKU call shape — the two failures that now REACH the SKU
    writer (they used to fail the run before it). Never an exception; the
    code beside the neutral text; and BOTH predicates name the result
    unusable — the structured code, and the text itself (so even a writer
    that only looked at the body could not take it for a briefing)."""
    reached = _arrange_r2(monkeypatch, response)
    try:
        out = _narrate_sku()
    except Exception as exc:  # noqa: BLE001 — the law is "never raises"
        pytest.fail("stage_narrate RAISED %s(%s) on the SKU call shape" % (type(exc).__name__, exc))
    assert reached() == 1, "the provider was never reached: the branch under test did not run"
    assert out.get("unavailable") == code, out
    assert out["briefing"] == text
    assert out["recommendations"] == []
    assert P.narration_unavailable_code(out) == code
    assert P.stored_briefing_failure_code(out["briefing"]) == code
    # No provider or SDK text in anything a writer stores.
    assert "proxies" not in out["briefing"] and "TypeError" not in out["briefing"]


def _function(tree: ast.AST, name: str) -> ast.FunctionDef:
    hits = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name]
    assert len(hits) == 1, "expected exactly one def %s in pipeline.py, found %d" % (name, len(hits))
    return hits[0]


def _dict_keys(node: ast.Dict) -> List[Any]:
    return [k.value if isinstance(k, ast.Constant) else None for k in node.keys]


def test_census_every_literal_return_of_the_narrator_that_names_a_briefing_names_its_code():
    """The branches above are the ones this file knows. The census reads the
    source: a `return {...}` inside `stage_narrate` that carries a `briefing`
    is a failure branch (the usable path returns the guarded dict by name)
    and must carry `unavailable` with one of the six codes."""
    fn = _function(ast.parse(PIPELINE_PY.read_text("utf-8")), "stage_narrate")
    literal_returns = [n.value for n in ast.walk(fn)
                       if isinstance(n, ast.Return) and isinstance(n.value, ast.Dict)
                       and "briefing" in _dict_keys(n.value)]
    # FLOOR (measured 5: no key, no SDK, provider error, not JSON, not an
    # object). Finding fewer means the census lost its subject.
    assert len(literal_returns) >= 5, "census found %d literal failure returns" % len(literal_returns)
    for node in literal_returns:
        keys = _dict_keys(node)
        assert "unavailable" in keys, "line %d returns a briefing without a code" % node.lineno
        assert "recommendations" in keys, "line %d returns no recommendations list" % node.lineno
        value = node.values[keys.index("unavailable")]
        named = [c.value for c in ast.walk(value) if isinstance(c, ast.Constant) and isinstance(c.value, str)]
        assert named and set(named) <= set(CODES), "line %d names %r" % (node.lineno, named)


# ══ S2 — the predicate for THIS narration ═════════════════════════════════

@pytest.mark.parametrize("code", CODES)
def test_the_structured_code_decides_whatever_the_body_says(code):
    """An unparseable reply is a fragment of anything — it can read as
    prose. The code, not the text, is what makes it unusable."""
    assert P.narration_unavailable_code({"briefing": GOOD, "unavailable": code}) == code


@pytest.mark.parametrize("code", ["rate_limited", "PROVIDER_ERROR", "Error code: 400", "1", True, 7],
                         ids=["new_word", "wrong_case", "provider_text", "digit", "true", "number"])
def test_an_unknown_code_is_reported_as_a_provider_error_never_passed_through(code):
    """The code is stored (`stale_reason`) and served: it is one of six
    neutral words, never whatever a branch happened to put there."""
    assert P.narration_unavailable_code({"briefing": GOOD, "unavailable": code}) == "provider_error"


@pytest.mark.parametrize("result", [None, "Agras closed the year well.", [GOOD], 42, True],
                         ids=["none", "str", "list", "int", "bool"])
def test_a_result_that_is_not_a_dict_is_unusable(result):
    assert P.narration_unavailable_code(result) in CODES


@pytest.mark.parametrize("result,code", [
    ({"briefing": SENTINEL}, "provider_error"),
    ({"briefing": NO_KEY_SENTENCE, "recommendations": []}, "no_api_key"),
    ({"briefing": NO_SDK_SENTENCE}, "sdk_missing"),
    ({"briefing": EMPTY_REPLY_SENTENCE}, "empty_reply"),
    ({"briefing": WITHHELD_SENTENCE}, "withheld_numerals"),
    ({"briefing": ""}, "empty_reply"),
    ({"briefing": None}, "empty_reply"),
    ({"recommendations": []}, "empty_reply"),
    ({}, "empty_reply"),
    # A reply the model wrapped twice: the `briefing` it handed back is the
    # head of a JSON reply, not prose (R3 on a FRESH narration).
    ({"briefing": TRUNCATED_JSON_FRAGMENT, "recommendations": []}, "unparseable_reply"),
], ids=["sentinel", "no_key", "no_sdk", "empty_sentence", "withheld", "empty", "null", "no_body", "nothing",
        "a_reply_fragment"])
def test_a_codeless_result_whose_body_is_a_failure_text_is_unusable(result, code):
    """A caller that builds a narration without the code (a stub, an older
    branch) cannot get a failure text written as a briefing."""
    assert P.narration_unavailable_code(result) == code


@pytest.mark.parametrize("result", [
    {"briefing": "stub"},
    {"briefing": GOOD, "recommendations": [], "alerts": []},
    {"briefing": GOOD_RO},
    {"briefing": GOOD, "unavailable": None},
    {"briefing": GOOD, "unavailable": ""},
    {"briefing": CREDIT_BALANCE_PROSE, "recommendations": []},
], ids=["stub", "prose", "romanian", "null_code", "empty_code", "says_a_credit_balance_is_too_low"])
def test_a_codeless_result_whose_body_is_prose_is_usable(result):
    """`{"briefing": "stub"}` is what the route gates hand the writers; a
    predicate that refused it would make every one of them vacuous.

    The last row is what the REAL narrator returns for a good reply that
    says a provider phrase (it carries no code — see USABLE_REPLIES): a
    refusal here is a fresh good briefing thrown away (R1)."""
    assert P.narration_unavailable_code(result) is None


# ══ S3 — the predicate for a row ALREADY stored ═══════════════════════════

STORED_FAILURE_TEXTS = [
    ("empty", "", "empty_reply"),
    ("whitespace", "  \n\t ", "empty_reply"),
    ("null", None, "empty_reply"),
    ("sentinel", SENTINEL, "provider_error"),
    ("sentinel_padded", " %s\n" % SENTINEL, "provider_error"),
    ("empty_reply_sentence", EMPTY_REPLY_SENTENCE, "empty_reply"),
    # The provider branch before 2026-08-04 stored f"Narrative unavailable: {e}".
    ("legacy_provider_credit", "Narrative unavailable: " + PROVIDER_ERROR_TEXT, "provider_error"),
    ("legacy_provider_auth",
     "Narrative unavailable: Error code: 401 - {'type': 'error', 'error': "
     "{'type': 'authentication_error', 'message': 'invalid x-api-key'}}", "provider_error"),
    ("legacy_provider_connection", "Narrative unavailable: Connection error.", "provider_error"),
    ("provider_text_bare", PROVIDER_ERROR_TEXT, "provider_error"),
    ("provider_overloaded",
     "Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}",
     "provider_error"),
    ("no_key_sentence", NO_KEY_SENTENCE, "no_api_key"),
    ("no_sdk_sentence", NO_SDK_SENTENCE, "sdk_missing"),
    ("withheld_sentence", WITHHELD_SENTENCE, "withheld_numerals"),
]


@pytest.mark.parametrize("body,code", [c[1:] for c in STORED_FAILURE_TEXTS],
                         ids=[c[0] for c in STORED_FAILURE_TEXTS])
def test_every_failure_text_a_writer_has_stored_is_recognised_with_its_neutral_code(body, code):
    assert P.stored_briefing_failure_code(body) == code


STORED_PROSE = [
    ("english", GOOD),
    ("romanian_with_diacritics", GOOD_RO),
    ("with_figures", "EBITDA was 10.8M."),
    ("stub", "stub"),
    ("unavailable_mid_sentence",
     "Prior-year comparatives were unavailable, so growth is not stated; margins remain healthy."),
    ("quotes_a_ratio_refusal",
     "Net debt unavailable: cash not reported for this period. Otherwise the balance sheet is conservative."),
    ("the_narrative_mid_sentence",
     "The narrative unavailable last quarter is now complete: revenue grew and costs fell."),
    ("starts_with_set", "Set against a healthy EBITDA margin, leverage is modest."),
    ("withheld_mid_sentence", "Dividends were withheld this year to fund the capex programme."),
    ("credit_balance_of_a_supplier", "The supplier credit balance improved and receivables were collected faster."),
    ("an_accounting_error", "A classification error in the accruals was corrected before closing."),
    ("romanian_indisponibil",
     "Fluxul de numerar nu este disponibil pentru anul precedent; în rest, poziția financiară este solidă."),
    # The boundary the provider pattern actually has (R1). The row
    # "credit_balance_of_a_supplier" above steps around it ("… improved");
    # these two do not.
    ("credit_balance_too_low_in_prose", CREDIT_BALANCE_PROSE),
    ("credit_balance_too_low_starts_the_briefing", CREDIT_BALANCE_PROSE_AT_THE_START),
    # EVERY failure shape is anchored at the START of the body. What the
    # repaired pattern still names ("Error code: N"), the phrases it dropped,
    # and the two reply heads (R3) — each in the MIDDLE of a sentence: prose.
    ("an_error_code_mid_sentence",
     "The bank export returned Error code: 5 twice before the statement was reloaded; the figures are final."),
    ("a_provider_error_type_mid_sentence",
     "The ERP log shows an invalid_request_error on the March import; the ledger itself is complete."),
    ("an_authentication_error_mid_sentence",
     "The bank feed stopped after an authentication_error in June, so cash is read from the trial balance."),
    ("a_brace_mid_sentence", "Margins held {see note 4} and liquidity is comfortable."),
    ("a_backtick_mid_sentence", "The `EBITDA` margin held and liquidity is comfortable."),
]


@pytest.mark.parametrize("body", [c[1] for c in STORED_PROSE], ids=[c[0] for c in STORED_PROSE])
def test_prose_is_never_mistaken_for_a_failure_text(body):
    """A false positive is not a harmless refusal: it serves a good briefing
    `body: null`, lets a failed narration overwrite it, and — because the
    predicate for a FRESH narration falls back to this one — refuses a good
    reply that says the same words."""
    assert P.stored_briefing_failure_code(body) is None


#: Bodies the pre-fix not-JSON branch stored as the briefing (`text[:500]`)
#: that a predicate CAN name: no briefing begins with `{` or a backtick.
STORED_REPLY_FRAGMENTS = [
    ("json_reply_cut_off", TRUNCATED_JSON_FRAGMENT),
    ("json_reply_with_trailing_text",
     '{"briefing": "Margins held.", "recommendations": []}\n\nLet me know if you need anything else.'),
    ("json_reply_in_single_backticks", '`{"briefing": "Margins held."}`'),
    # The scout's own shape is left(LTRIM(body), 1): leading whitespace does
    # not make a reply fragment a briefing.
    ("json_reply_after_whitespace", '\n  {"briefing": "Margins held'),
]


@pytest.mark.parametrize("body", [c[1] for c in STORED_REPLY_FRAGMENTS],
                         ids=[c[0] for c in STORED_REPLY_FRAGMENTS])
def test_a_stored_fragment_of_a_json_reply_is_a_failure_text_and_never_a_briefing(body):
    """SPEC D5's list of stored failure texts does not name it; the scout's
    does (§1: the not-JSON branch returned `text[:500]`, and every writer
    stored it; §3: `raw_reply_fragment`, "left(ltrim(body),1) in ('{','`')").
    It IS a failure text a writer has stored. Before the repair it was prose
    to the predicate (R3): served as the briefing, and kept as "the last
    good one". The code is the one the narrator returns beside the very same
    text. (Owner ruling 2026-10-03: "everything the gate tests belongs in
    this hotfix".)"""
    assert P.stored_briefing_failure_code(body) == "unparseable_reply"


# ══ S4 — GET /api/period: the served shape ════════════════════════════════

SERVED_FAILURES = [c for c in STORED_FAILURE_TEXTS if c[1] is not None]  # `body text not null`


@pytest.mark.parametrize("body,code", [c[1:] for c in SERVED_FAILURES], ids=[c[0] for c in SERVED_FAILURES])
def test_a_stored_failure_text_is_served_unavailable_with_a_null_body(body, code):
    """Measured before the fix: the route served the text as `body` and the
    report printed `[NARRATIVE_UNAVAILABLE]` as the executive briefing."""
    double = _world(briefing={"body": body, "language": "en", "model": "claude-test-model"})
    served = _served(double)
    assert served["body"] is None, served
    assert served["unavailable"] is True
    assert served["unavailable_reason"] == code
    # Additive only: the earlier keys are still there.
    assert served["language"] == "en" and served["model"] == "claude-test-model"
    assert isinstance(served["definition"], dict) and "written_under_previous_definition" in served["definition"]
    # …and the failure text is nowhere in what the page is handed.
    if body.strip():
        assert body.strip() not in json.dumps(served, ensure_ascii=False), served


def test_a_usable_stored_briefing_is_served_as_its_prose_with_every_earlier_key():
    """The positive control of the test above (a route that nulled every
    body would pass it) and the additive-only law of SPEC D8."""
    double = _world(briefing=_usable_row(GOOD_RO, language="ro"))
    served = _served(double)
    assert served["body"] == GOOD_RO
    assert served["unavailable"] is False and served["unavailable_reason"] is None
    assert served["language"] == "ro" and served["model"] == "claude-test-model"
    assert served["definition"]["written_under_previous_definition"] is False
    assert served["definition"]["note"] is None
    assert served["stale"] is None
    assert {"body", "language", "model", "definition", "unavailable", "unavailable_reason",
            "stale"} <= set(served), sorted(served)


def test_the_stale_marker_is_served_when_the_row_carries_it():
    double = _world(briefing=_usable_row(stale_since="2026-10-02T18:46:00+00:00",
                                         stale_reason="provider_error"))
    served = _served(double)
    assert served["stale"] == {"since": "2026-10-02T18:46:00+00:00", "reason": "provider_error"}
    # A stale briefing is still the briefing: kept, served, not unavailable.
    assert served["body"] == GOOD and served["unavailable"] is False


def test_a_current_row_is_served_with_a_null_stale_whether_or_not_the_columns_exist():
    applied = _world(briefing=_usable_row())
    assert set(STALE_COLUMNS) <= set(_briefing_rows(applied)[0]), "the applied world carries no stale columns"
    assert _served(applied)["stale"] is None

    before = _world(migration_applied=False, briefing=_usable_row())
    assert not set(STALE_COLUMNS) & set(_briefing_rows(before)[0]), "the row carries the columns anyway"
    served = _served(before)
    assert served["stale"] is None
    assert served["body"] == GOOD and served["unavailable"] is False


def test_a_period_with_no_briefing_row_is_served_a_null_briefing_as_before():
    assert _get_period(_world())["briefing"] is None


def test_a_failure_text_row_that_also_carries_a_stale_marker_is_still_served_unavailable():
    """The marker says "a later narration failed"; it never turns a failure
    text into a briefing. (A reader that skipped the text check for a marked
    row would print `[NARRATIVE_UNAVAILABLE]` under "stale".)"""
    double = _world(briefing={"body": SENTINEL, "language": "en", "model": "claude-test-model",
                              "stale_since": "2026-10-02T18:46:00+00:00", "stale_reason": "no_api_key"})
    served = _served(double)
    assert served["body"] is None, served
    assert served["unavailable"] is True and served["unavailable_reason"] == "provider_error"
    assert "NARRATIVE_UNAVAILABLE" not in json.dumps(served), served


def test_a_stored_briefing_that_says_a_credit_balance_is_too_low_is_served_as_its_prose():
    """R1 on the reader: the row is a good briefing. Served `body: null` the
    card does not mount, and the next failed narration overwrites the row
    (it is "nothing to protect")."""
    double = _world(briefing=_usable_row(CREDIT_BALANCE_PROSE))
    served = _served(double)
    assert served["body"] == CREDIT_BALANCE_PROSE, served
    assert served["unavailable"] is False and served["unavailable_reason"] is None


def test_a_stored_fragment_of_a_json_reply_is_served_unavailable_and_never_as_the_briefing():
    """R3 on the reader: the dashboard would print `{"briefing": "The
    company posted reven` as the executive briefing."""
    double = _world(briefing=_usable_row(TRUNCATED_JSON_FRAGMENT))
    served = _served(double)
    assert served["body"] is None, served
    assert served["unavailable"] is True and served["unavailable_reason"] == "unparseable_reply"
    assert "posted reven" not in json.dumps(served), served


def _reader_of_both_workspaces(double: D.PostgrestDouble) -> None:
    """The double has no RLS. A reader for whom that is the TRUTH is a member
    of both workspaces (an accountant with two companies; firm staff with
    two cells) — so the world says so, instead of leaning on a wall the
    double does not have."""
    double.add("organizations", {"id": OTHER_ORG, "name": "another company", "default_currency": "RON"})
    double.add("memberships", {"user_id": USER, "org_id": OTHER_ORG, "role": "member",
                               "created_at": "2026-02-01T00:00:00+00:00"})


def test_get_period_serves_only_a_briefing_row_of_the_periods_own_workspace():
    """`briefings.period_id` is browser-writable on a row of the writer's OWN
    workspace (schema_phase3.sql: `insert with check (is_member_of(org_id))`;
    the foreign key only asks that the period exists). A member of another
    workspace who can see this period can therefore put a row on it while it
    has none. The regenerate route reads the stored row with the tenant in
    the filter and answers null (the test of that is below); GET /api/period
    read by `period_id` alone and served row [0] (R4).

    OWNER RULING 2026-10-03: "The period read without workspace is a tenant
    boundary bug and can't ship." The period's briefing is the row of the
    period's OWN org, or nothing."""
    double = _world()
    _reader_of_both_workspaces(double)
    double.add("briefings", dict(FOREIGN_BRIEFING))
    payload = _get_period(double)
    assert payload["briefing"] is None, payload["briefing"]
    assert "Foreign prose" not in json.dumps(payload, ensure_ascii=False)

    # Positive control: the SAME reader is served the period's own row — the
    # second membership is not what empties the answer.
    own = _world(briefing=_usable_row())
    _reader_of_both_workspaces(own)
    assert _served(own)["body"] == GOOD


@pytest.mark.parametrize("foreign_first", [True, False], ids=["foreign_row_first", "own_row_first"])
def test_get_period_serves_the_periods_own_row_whichever_row_the_database_lists_first(foreign_first):
    """"Row [0]" is whichever row the database happens to list first. With a
    foreign row AND the period's own row on the same period (the double
    enforces no `unique (period_id)`; the ruling does not lean on it), the
    reader is served the period's own briefing in either order — never the
    other workspace's, and never a null because a foreign row stood first."""
    double = _world()
    _reader_of_both_workspaces(double)
    own = dict({"period_id": PID, "org_id": ORG}, **_usable_row())
    for row in ([FOREIGN_BRIEFING, own] if foreign_first else [own, FOREIGN_BRIEFING]):
        double.add("briefings", dict(row))
    assert [r["org_id"] for r in _briefing_rows(double)] == (
        [OTHER_ORG, ORG] if foreign_first else [ORG, OTHER_ORG]), "the world is not the one described"
    payload = _get_period(double)
    assert payload["briefing"]["body"] == GOOD, payload["briefing"]
    assert "Foreign prose" not in json.dumps(payload, ensure_ascii=False)


def test_get_period_reads_briefings_with_the_period_and_its_tenant_in_the_filter():
    """The dynamic half of the select census below — what GET /api/period
    actually SENT. `period_id` alone is not a tenant filter; the tenant named
    is the PERIOD's own org (never a header, never the caller's first
    membership): the reader here sends `X-Org-Id` of the period's org and is
    also a member of another one."""
    double = _world(briefing=_usable_row())
    _reader_of_both_workspaces(double)
    assert _served(double)["body"] == GOOD
    reads = double.selects("briefings")
    # FLOOR: the route read the table at all (none recorded = nothing examined).
    assert len(reads) >= 1, double.calls
    for _op, _table, filters, _columns in reads:
        assert filters == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, filters


# ══ S5 — round trip through the real routes ═══════════════════════════════

def test_a_failed_regenerate_is_served_stale_with_the_same_body_and_a_later_good_one_clears_it(
        monkeypatch):
    double = _world(briefing=_usable_row())
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    before = _store(double)
    assert before["briefings"][0]["body"] == GOOD and before["financial_periods"], sorted(before)

    failed = _regenerate(double, {"intent": "user"})
    assert failed.status_code == 200, failed.text[:400]
    answer = failed.json()
    assert len(provider.calls) == 1, "the model was never asked: the failure path did not run"
    assert answer["ok"] is False and answer["regenerated"] is False
    assert answer["reason"] == "provider_error" and answer["stale"] is True
    assert answer["briefing"] == GOOD
    assert "credit balance" not in failed.text

    # THE WHOLE STORE, not one field: nothing but the two marker columns of
    # the one briefings row may differ (no upsert, no `updated_at` touch).
    assert _without_marker(_store(double)) == _without_marker(before)
    row = _briefing_rows(double)[0]
    assert row["stale_reason"] == "provider_error"
    assert isinstance(row["stale_since"], str) and row["stale_since"], row

    served = _served(double)
    assert served["body"] == GOOD
    assert served["unavailable"] is False and served["unavailable_reason"] is None
    assert served["stale"] == {"since": row["stale_since"], "reason": "provider_error"}

    # A later GOOD narration: written, in its true language, marker cleared.
    provider.reply = json.dumps({"briefing": FRESH_RO, "recommendations": []}, ensure_ascii=False)
    good = _regenerate(double, {"intent": "user", "language": "ro", "currency": "RON"})
    assert good.status_code == 200, good.text[:400]
    answer = good.json()
    assert answer["ok"] is True and answer["regenerated"] is True and answer["persisted"] is True
    assert answer["briefing"] == FRESH_RO and answer["stale"] is False
    assert len(provider.calls) == 2

    served = _served(double)
    assert served["body"] == FRESH_RO
    assert served["stale"] is None
    assert served["unavailable"] is False
    assert served["language"] == "ro"
    row = _briefing_rows(double)[0]
    assert row["stale_since"] is None and row["stale_reason"] is None, row
    assert len(_briefing_rows(double)) == 1


@pytest.mark.parametrize("second_failure,reason", [
    (lambda: NOT_JSON_REPLY, "unparseable_reply"),
    (lambda: RuntimeError(PROVIDER_ERROR_TEXT), "provider_error"),
], ids=["for_another_reason", "for_the_same_reason_again"])
def test_a_second_failure_keeps_the_first_stale_since_and_takes_the_newest_reason(
        second_failure, reason, monkeypatch):
    """`stale_since` is when the FIRST narration since the last good write
    failed (the migration's own definition): a later failure must not make
    the kept briefing look freshly stale — neither for another reason nor
    for the same one again (credits exhausted for days is the common
    sequence)."""
    first = "2026-09-30T08:00:00+00:00"
    double = _world(briefing=_usable_row(stale_since=first, stale_reason="provider_error"))
    provider = _install_provider(monkeypatch, second_failure())
    resp = _regenerate(double, {"intent": "user"})
    assert len(provider.calls) == 1
    assert resp.status_code == 200 and resp.json()["reason"] == reason, resp.text[:400]
    assert resp.json()["stale"] is True  # the row carries the marker: the answer says so
    assert _served(double)["stale"] == {"since": "2026-09-30T08:00:00+00:00", "reason": reason}
    assert _briefing_rows(double)[0]["body"] == GOOD


def test_a_stored_failure_row_is_never_handed_back_or_marked_and_a_good_regenerate_replaces_it(
        monkeypatch):
    """The production state of every period overwritten BEFORE the fix, and
    the first thing clicked after the deploy ("Generate the briefing" on an
    unavailable card). The stored `[NARRATIVE_UNAVAILABLE]` is not "the
    briefing that was kept": it is never answered as `briefing`, never
    marked stale (there is no briefing to be stale), and a good narration
    replaces it.

    The row carries TODAY's definition stamp (as every row the pipeline
    wrote since 2026-09-26 does): the null answered below is then about the
    BODY — an unstamped row is answered null for the definition note alone,
    and a route that handed the sentinel back would pass."""
    double = _world(briefing={"body": SENTINEL, "language": "en", "model": "claude-test-model",
                              "ebitda_definition": EBITDA_DEFINITION_REVISION})
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    before = _store(double)

    legacy = _regenerate(double, None)
    assert legacy.status_code == 200 and legacy.json()["briefing"] is None, legacy.text[:400]
    failed = _regenerate(double, {"intent": "user"})
    assert failed.status_code == 200, failed.text[:400]
    answer = failed.json()
    assert len(provider.calls) == 1, "the model was never asked: the failure path did not run"
    assert answer["ok"] is False and answer["regenerated"] is False
    assert answer["reason"] == "provider_error"
    # TRUTHFUL (owner ruling 2026-10-03, "Never report a state that isn't
    # stored"): nothing usable is stored, nothing was marked — `stale` is
    # false. (SPEC D6a's literal `stale: true` was pinned here before.)
    assert answer["stale"] is False, answer
    assert answer["briefing"] is None and answer["briefing_length"] == 0
    assert "NARRATIVE_UNAVAILABLE" not in legacy.text + failed.text
    assert _store(double) == before, "a failure row was written or marked"
    served = _served(double)
    assert served["body"] is None and served["unavailable"] is True
    assert served["unavailable_reason"] == "provider_error" and served["stale"] is None

    provider.reply = json.dumps({"briefing": FRESH_RO, "recommendations": []}, ensure_ascii=False)
    good = _regenerate(double, {"intent": "user", "language": "ro", "currency": "RON"})
    assert good.status_code == 200, good.text[:400]
    assert good.json()["ok"] is True and good.json()["persisted"] is True
    assert good.json()["briefing"] == FRESH_RO
    served = _served(double)
    assert served["body"] == FRESH_RO
    assert served["unavailable"] is False and served["unavailable_reason"] is None
    assert served["stale"] is None and served["language"] == "ro"
    assert len(_briefing_rows(double)) == 1


def test_a_good_regenerate_whose_prose_says_a_credit_balance_is_too_low_is_written_and_served(
        monkeypatch):
    """R1 on the writer side. The real narrator returns this reply with NO
    code (USABLE_REPLIES); the route then asks the TEXT predicate, which
    finds a provider phrase in the middle of the sentence — measured: 200
    `ok: false, reason: provider_error, stale: true`, the OLD body handed
    back, the kept row marked stale, the good briefing thrown away."""
    double = _world(briefing=_usable_row())
    provider = _install_provider(monkeypatch, json.dumps({"briefing": CREDIT_BALANCE_PROSE,
                                                          "recommendations": []}))
    resp = _regenerate(double, {"intent": "user"})
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert len(provider.calls) == 1
    assert answer["ok"] is True and answer["regenerated"] is True, answer
    assert answer["briefing"] == CREDIT_BALANCE_PROSE and answer["stale"] is False
    rows = _briefing_rows(double)
    assert len(rows) == 1 and rows[0]["body"] == CREDIT_BALANCE_PROSE, rows
    assert rows[0]["stale_since"] is None and rows[0]["stale_reason"] is None, rows[0]
    served = _served(double)
    assert served["body"] == CREDIT_BALANCE_PROSE
    assert served["unavailable"] is False and served["stale"] is None


def test_a_stored_reply_fragment_is_never_handed_back_as_the_briefing_that_was_kept(monkeypatch):
    """R3 on the route: a fragment is not "the last good one". (The row is
    stamped with today's definition, so the null asked for below is about
    the BODY, not about the definition note.)"""
    double = _world(briefing=_usable_row(TRUNCATED_JSON_FRAGMENT))
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    before = _store(double)
    legacy = _regenerate(double, None)
    failed = _regenerate(double, {"intent": "user"})
    assert legacy.status_code == 200 and failed.status_code == 200, (legacy.text[:300], failed.text[:300])
    assert len(provider.calls) == 1
    assert failed.json()["ok"] is False and failed.json()["reason"] == "provider_error"
    assert legacy.json()["briefing"] is None, legacy.json()
    assert failed.json()["briefing"] is None, failed.json()
    assert "posted reven" not in legacy.text + failed.text
    assert _store(double) == before, "a reply fragment was marked stale as if it were a briefing"
    # Truthful (ruling 2026-10-03): no briefing is kept, none is stale.
    assert failed.json()["stale"] is False, failed.json()
    assert _served(double)["stale"] is None


def test_before_the_migration_is_applied_a_failure_keeps_the_row_and_a_good_narration_still_writes(
        monkeypatch, caplog):
    """SPEC D7: "the backend is correct BEFORE the migration is applied".
    The double refuses the two columns as PostgREST would; the marker update
    is then refused, logged ONCE and swallowed — and a briefing WRITE must
    not name them at all, or every briefing write would depend on the
    migration.

    OWNER RULING 2026-10-03 ("Never report a state that isn't stored"): a
    marker the database REFUSED is not a stale briefing — the answer says
    `stale: false`, exactly what GET /api/period then serves (`stale:
    null`). SPEC D7's "stale is then carried by the regenerate response" is
    superseded: this test pinned `stale: true` beside an unmarked row."""
    double = _world(migration_applied=False, briefing=_usable_row())
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    before = _store(double)

    with caplog.at_level(logging.WARNING, logger="engine.api.pipeline"):
        failed = _regenerate(double, {"intent": "user"})
    # Not silent (an operator must be able to see why "stale" is not durable
    # yet) and not a traceback per request: one line, from the marker writer.
    refused = [r for r in caplog.records if r.funcName == "_mark_briefing_stale"]
    assert len(refused) == 1 and refused[0].levelno == logging.WARNING, [
        (r.funcName, r.levelname) for r in caplog.records]
    assert refused[0].exc_info is None
    assert failed.status_code == 200, failed.text[:400]
    answer = failed.json()
    assert answer["ok"] is False and answer["reason"] == "provider_error"
    assert answer["stale"] is False, answer  # nothing was stored: nothing is reported
    assert answer["briefing"] == GOOD
    assert _store(double) == before, "a failed regenerate changed the store"
    # The marker WAS attempted (and refused): the path under test ran.
    assert [c for c in double.calls if c[0] == "update" and c[1] == "briefings"], double.calls[-6:]
    served = _served(double)
    assert served["body"] == GOOD and served["stale"] is None and served["unavailable"] is False

    provider.reply = json.dumps({"briefing": FRESH_RO, "recommendations": []}, ensure_ascii=False)
    good = _regenerate(double, {"intent": "user"})
    assert good.status_code == 200, good.text[:400]
    assert good.json()["ok"] is True and good.json()["persisted"] is True
    assert good.json()["stale"] is False
    assert _served(double)["body"] == FRESH_RO and _served(double)["stale"] is None
    assert not set(STALE_COLUMNS) & set(_briefing_rows(double)[0])


def test_a_failed_rerun_narration_is_served_stale_with_the_same_body_and_a_good_rerun_clears_it(
        monkeypatch):
    """The same round trip on the PIPELINE's writer: the real narrator fails
    (no API key), the real `stage_persist_narrative` runs on a period that
    already holds a briefing and a recommendation — measured before the fix
    as the operator sentence stored over the briefing and the recommendation
    deleted."""
    double = _world(briefing=_usable_row())
    double.add("recommendations", {"org_id": ORG, "period_id": PID, "title": "Build a liquidity buffer",
                                   "explanation": "Cash covers a thin share of short-term liabilities.",
                                   "urgency": "high", "status": "new"})
    before = _store(double)
    assert len(before["recommendations"]) == 1 and before["briefings"][0]["body"] == GOOD

    _install_provider(monkeypatch, "{}", key=None)
    failed = _narrate()
    assert failed.get("unavailable") == "no_api_key"
    with RA.installed(double):
        P.stage_persist_narrative(dict(DOC), PID, failed, [])
    assert _without_marker(_store(double)) == _without_marker(before)
    row = _briefing_rows(double)[0]
    assert row["stale_reason"] == "no_api_key"
    assert isinstance(row["stale_since"], str) and row["stale_since"], row
    served = _served(double)
    assert served["body"] == GOOD and served["unavailable"] is False
    assert served["stale"] == {"since": row["stale_since"], "reason": "no_api_key"}

    _install_provider(monkeypatch, json.dumps({"briefing": FRESH_RO, "recommendations": []},
                                              ensure_ascii=False))
    good = _narrate()
    assert "unavailable" not in good
    with RA.installed(double):
        P.stage_persist_narrative(dict(DOC), PID, good, [])
    served = _served(double)
    assert served["body"] == FRESH_RO and served["stale"] is None and served["unavailable"] is False
    row = _briefing_rows(double)[0]
    assert row["stale_since"] is None and row["stale_reason"] is None, row
    assert len(_briefing_rows(double)) == 1


def test_before_the_migration_a_failed_rerun_keeps_the_briefing_and_the_recommendations_unmarked(
        monkeypatch, caplog):
    """SPEC D7 on the PIPELINE's writer: with the two columns absent, a
    failed re-run narration must still lose nothing and break nothing — the
    row and the recommendation byte-identical, the refused marker logged
    once and swallowed.

    What it CANNOT promise in that state is stated, not hidden: the kept
    briefing is then served with `stale: null`. Unlike the regenerate route
    a pipeline run has no response to carry "stale" for the session, so
    until supabase/schema_phase_briefing_stale.sql is applied NOTHING tells
    the reader that this prose was written for the previous file's figures
    (see CANNOT SEE; SPEC D7 accepts it as "optional until applied")."""
    double = _world(migration_applied=False, briefing=_usable_row())
    double.add("recommendations", {"org_id": ORG, "period_id": PID, "title": "Build a liquidity buffer",
                                   "explanation": "Cash covers a thin share of short-term liabilities.",
                                   "urgency": "high", "status": "new"})
    before = _store(double)
    assert len(before["recommendations"]) == 1 and before["briefings"][0]["body"] == GOOD

    _install_provider(monkeypatch, "{}", key=None)
    failed = _narrate()
    assert failed.get("unavailable") == "no_api_key"
    with caplog.at_level(logging.WARNING, logger="engine.api.pipeline"):
        with RA.installed(double):
            P.stage_persist_narrative(dict(DOC), PID, failed, [])
    assert _store(double) == before, "a failed re-run changed the store"
    # The marker WAS attempted, refused (unknown column) and logged once.
    assert [c for c in double.calls if c[0] == "update" and c[1] == "briefings"], double.calls[-6:]
    refused = [r for r in caplog.records if r.funcName == "_mark_briefing_stale"]
    assert len(refused) == 1 and refused[0].levelno == logging.WARNING and refused[0].exc_info is None, [
        (r.funcName, r.levelname) for r in caplog.records]
    served = _served(double)
    assert served["body"] == GOOD and served["unavailable"] is False
    assert served["stale"] is None  # SPEC D8: `stale` comes from the columns — there are none yet


def test_every_marker_write_of_the_round_trip_names_the_period_and_the_tenant(monkeypatch):
    """The dynamic half of the census below: what the route actually SENT."""
    double = _world(briefing=_usable_row())
    provider = _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))
    assert _regenerate(double, {"intent": "user"}).json()["ok"] is False
    provider.reply = json.dumps({"briefing": FRESH_RO}, ensure_ascii=False)
    assert _regenerate(double, {"intent": "user"}).json()["ok"] is True
    writes = [c for c in double.calls if c[0] in ("update", "delete") and c[1] == "briefings"]
    # FLOOR: the mark and the clear. None recorded means nothing was examined.
    assert len(writes) >= 2, double.calls
    for _op, _table, filters, _columns in writes:
        assert filters == {"period_id": "eq.%s" % PID, "org_id": "eq.%s" % ORG}, filters


def test_another_workspaces_row_on_this_period_is_never_answered_as_the_kept_briefing(monkeypatch):
    """`briefings.period_id` is a column a member of ANOTHER workspace can
    write on their own rows. The route reads "the stored briefing" under the
    service role: by period alone it would hand a foreign body back as "the
    briefing that was kept" and mark a foreign row stale."""
    double = _world()
    double.add("briefings", dict(FOREIGN_BRIEFING))
    before = copy.deepcopy(_briefing_rows(double))
    _install_provider(monkeypatch, RuntimeError(PROVIDER_ERROR_TEXT))

    legacy = _regenerate(double, None)
    assert legacy.status_code == 200 and legacy.json()["briefing"] is None, legacy.text[:400]
    failed = _regenerate(double, {"intent": "user"})
    assert failed.status_code == 200, failed.text[:400]
    assert failed.json()["ok"] is False and failed.json()["briefing"] is None
    assert "Foreign prose" not in legacy.text + failed.text
    assert _briefing_rows(double) == before, "the foreign row was written"
    # Truthful (ruling 2026-10-03): THIS workspace holds no briefing on the
    # period, so none is stale — and the two readers now agree: GET
    # /api/period serves no briefing either (R4, repaired).
    assert failed.json()["stale"] is False, failed.json()
    assert _get_period(double)["briefing"] is None


_MARKED = {"stale_since": "2026-09-30T08:00:00+00:00", "stale_reason": "no_api_key"}
_GOOD_REPLY = json.dumps({"briefing": FRESH_RO, "recommendations": []}, ensure_ascii=False)

#: (id, the period's stored row or None, is the stale migration applied, what
#: the provider answers, the `stale` the route must answer). The expected
#: value of every row is WRITTEN OUT here; the test then also holds it
#: against what GET /api/period serves right after the call.
TRUTHFUL_STALE = [
    ("a_usable_row_is_marked", lambda: _usable_row(), True,
     lambda: RuntimeError(PROVIDER_ERROR_TEXT), True),
    ("a_row_already_marked_stays_marked", lambda: _usable_row(**_MARKED), True,
     lambda: NOT_JSON_REPLY, True),
    ("before_the_migration", lambda: _usable_row(), False,
     lambda: RuntimeError(PROVIDER_ERROR_TEXT), False),
    ("a_stored_failure_text", lambda: {"body": SENTINEL, "language": "en", "model": "claude-test-model",
                                       "ebitda_definition": EBITDA_DEFINITION_REVISION}, True,
     lambda: RuntimeError(PROVIDER_ERROR_TEXT), False),
    ("a_stored_reply_fragment", lambda: _usable_row(TRUNCATED_JSON_FRAGMENT), True,
     lambda: RuntimeError(PROVIDER_ERROR_TEXT), False),
    ("nothing_stored", lambda: None, True,
     lambda: RuntimeError(PROVIDER_ERROR_TEXT), False),
    ("a_good_narration_over_a_marked_row", lambda: _usable_row(**_MARKED), True,
     lambda: _GOOD_REPLY, False),
    ("a_good_narration_before_the_migration", lambda: _usable_row(), False,
     lambda: _GOOD_REPLY, False),
]


@pytest.mark.parametrize("row,migration_applied,reply,stale", [c[1:] for c in TRUTHFUL_STALE],
                         ids=[c[0] for c in TRUTHFUL_STALE])
def test_the_answered_stale_is_what_get_period_serves_immediately_after(
        row, migration_applied, reply, stale, monkeypatch):
    """OWNER RULING 2026-10-03: "make the answer truthful … Never report a
    state that isn't stored." In every answer of the explicit regenerate,
    `stale` is a boolean, and it is true IF AND ONLY IF the period's stored
    briefing carries the marker when the call returns — which is exactly
    what the next GET /api/period serves (`briefing.stale` not null).

    Measured before the ruling: every ok:false answer said `stale: true` —
    with no briefing stored, with a failure text stored, and with a marker
    the database had refused (the migration not applied) — while the page's
    next read served `stale: null`.

    The first two rows and the last two are the positive controls (a route
    that always answered false, or always true, fails one of them)."""
    double = _world(migration_applied=migration_applied, briefing=row())
    provider = _install_provider(monkeypatch, reply())
    resp = _regenerate(double, {"intent": "user"})
    assert resp.status_code == 200, resp.text[:400]
    assert len(provider.calls) == 1, "the model was never asked: the path under test did not run"
    answer = resp.json()
    assert answer["stale"] is stale, answer
    served = _get_period(double)["briefing"]
    served_stale = served is not None and served["stale"] is not None
    assert answer["stale"] is served_stale, (answer, served)
    # …and the same thing read from the store itself, where the double has
    # the columns at all.
    rows = _briefing_rows(double)
    assert bool(rows and rows[0].get("stale_since")) is stale, rows


def _meter_on(monkeypatch) -> List[Tuple[str, Dict[str, Any]]]:
    """Enforcement ON, with the ONE function of the real usage gate that
    talks to the meter recorded. Like the real `_rpc` it answers a dict and
    never raises. Call it AFTER `_install_provider` (which switches
    enforcement off and makes any RPC a test failure). Returns the RPCs in
    the order the route made them.

    The plan is the real `_plan_state.get_plan_state`'s answer for a caller
    with no readable subscription (this double declares no `subscriptions`
    table): the trial plan, its documented fallback. The caps sent to the
    meter are the route seam's law and are not asserted here — only WHICH
    RPCs were made, in which order, and for whom."""
    seen: List[Tuple[str, Dict[str, Any]]] = []
    answers = {"reserve_user_chat": {"kind": "allowed", "daily_used": 1, "monthly_used": 1},
               "commit_user_chat": {"ok": True}, "release_user_chat": {"ok": True}}

    def _recorded_rpc(name: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        seen.append((name, dict(payload)))
        return answers.get(name)

    monkeypatch.setenv("USAGE_LIMITS_ENABLED", "true")
    monkeypatch.setattr(_usage_gate, "_rpc", _recorded_rpc)
    return seen


@pytest.mark.parametrize("response,code", [(c[1], c[2]) for c in R2_STATES], ids=[c[0] for c in R2_STATES])
def test_what_the_narrator_used_to_raise_on_is_an_ok_false_answer_of_the_real_route_never_a_500(
        response, code, monkeypatch):
    """R2 AS THE ROUTE MEETS IT (review 2026-10-03). Measured before the
    repair, for each of these provider states: the exception left
    `stage_narrate`, the route answered 500 "Briefing regeneration failed:
    TypeError" where SPEC D6a says 200 `ok: false`, and the page was told
    nothing about the briefing that had been kept.

    With the narrator returning its code: the SAME answer as any other
    failed narration — 200 `ok: false` with the neutral code, the kept body
    handed back, the kept row marked (so `stale: true` here is the stored
    state, and what GET /api/period serves next), nothing else written — and
    the reserved message GIVEN BACK, never committed, on the caller's own
    meter. (The route's 500 for an exception the narrator does NOT absorb is
    the route seam's law and stays with its gate; it can no longer be driven
    with these responses.)"""
    double = _world(briefing=_usable_row())
    reached = _arrange_r2(monkeypatch, response)
    meter = _meter_on(monkeypatch)
    before = _store(double)
    assert before["briefings"][0]["body"] == GOOD

    resp = _regenerate(double, {"intent": "user"})
    assert reached() == 1, "the provider was never reached: the path under test did not run"
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert answer["ok"] is False and answer["regenerated"] is False, answer
    assert answer["reason"] == code
    assert answer["briefing"] == GOOD and answer["briefing_length"] == 93
    assert answer["stale"] is True
    # No SDK text reaches the caller.
    assert "proxies" not in resp.text and "TypeError" not in resp.text

    # The unit: reserved, then released — the verified caller's, both times.
    assert [name for name, _payload in meter] == ["reserve_user_chat", "release_user_chat"], meter
    assert [payload["p_user_id"] for _name, payload in meter] == [USER, USER]

    # THE WHOLE STORE: nothing but the two marker columns of the one row.
    assert _without_marker(_store(double)) == _without_marker(before)
    row = _briefing_rows(double)[0]
    assert row["body"] == GOOD and row["stale_reason"] == code
    assert isinstance(row["stale_since"], str) and row["stale_since"], row
    served = _served(double)
    assert served["body"] == GOOD and served["unavailable"] is False
    assert served["stale"] == {"since": row["stale_since"], "reason": code}


def test_the_same_metered_route_commits_the_unit_when_the_narration_is_usable(monkeypatch):
    """The positive control of the test above: a recorder that named every
    settlement a release — or a world in which no narration can succeed —
    would pass it."""
    double = _world(briefing=_usable_row())
    provider = _install_provider(monkeypatch, _GOOD_REPLY)
    meter = _meter_on(monkeypatch)
    resp = _regenerate(double, {"intent": "user"})
    assert resp.status_code == 200 and resp.json()["ok"] is True, resp.text[:400]
    assert len(provider.calls) == 1
    assert [name for name, _payload in meter] == ["reserve_user_chat", "commit_user_chat"], meter
    assert [payload["p_user_id"] for _name, payload in meter] == [USER, USER]
    assert _briefing_rows(double)[0]["body"] == FRESH_RO


# ══ S6 — census: what the writers may send ════════════════════════════════

def _briefings_calls(method_names: Tuple[str, ...]) -> List[Tuple[Path, ast.Call]]:
    """Every `<client>.<method>("briefings", …)` call in src/engine."""
    found: List[Tuple[Path, ast.Call]] = []
    files = sorted(ENGINE_SRC.rglob("*.py"))
    assert len(files) > 100, "the census walked %d files of src/engine" % len(files)
    for path in files:
        source = path.read_text("utf-8")
        if "briefings" not in source:
            continue
        for node in ast.walk(ast.parse(source)):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in method_names and node.args
                    and isinstance(node.args[0], ast.Constant) and node.args[0].value == "briefings"):
                found.append((path, node))
    return found


def test_census_no_briefings_upsert_payload_names_a_stale_column():
    """An upsert naming a column PostgREST does not know is rejected WHOLE:
    with the marker inside the payload every briefing write would depend on
    the migration (the trap recorded in
    schema_phase_briefing_ebitda_definition.sql)."""
    upserts = _briefings_calls(("upsert", "insert"))
    # FLOOR (measured 2: stage_persist_narrative and the regenerate route).
    assert len(upserts) >= 2, "census found %d briefing upserts" % len(upserts)
    for path, call in upserts:
        where = "%s:%d" % (path.relative_to(REPO), call.lineno)
        assert len(call.args) >= 2 and isinstance(call.args[1], ast.Dict), (
            "%s: the payload is not a dict literal — this census cannot read it" % where)
        keys = _dict_keys(call.args[1])
        assert None not in keys, "%s: a computed or unpacked key — this census cannot read it" % where
        # Non-vacuity: it IS the briefing payload.
        assert "body" in keys and "period_id" in keys, (where, keys)
        assert not set(keys) & set(STALE_COLUMNS), "%s writes %s inside the upsert" % (where, keys)
        strings = [c.value for c in ast.walk(call) if isinstance(c, ast.Constant) and isinstance(c.value, str)]
        assert not [s for s in strings if s in STALE_COLUMNS], where


def test_census_every_update_or_delete_on_briefings_names_the_tenant():
    """The marker is written, and the staged failure row deleted, under the
    SERVICE ROLE: `period_id` alone would touch whichever row carries it."""
    writes = _briefings_calls(("update", "update_returning", "delete"))
    # FLOOR (measured 3: mark stale, clear stale, the takeover's delete).
    assert len(writes) >= 3, "census found %d update/delete call sites" % len(writes)
    for path, call in writes:
        where = "%s:%d" % (path.relative_to(REPO), call.lineno)
        filters = [k.value for k in call.keywords if k.arg == "filters"]
        assert len(filters) == 1 and isinstance(filters[0], ast.Dict), "%s: no literal filters" % where
        keys = _dict_keys(filters[0])
        assert "org_id" in keys and "period_id" in keys, "%s filters on %s" % (where, keys)


def test_census_every_select_on_briefings_names_the_period_and_the_tenant():
    """Owner ruling 2026-10-03: "The period read without workspace is a
    tenant boundary bug and can't ship." `period_id` alone is not a tenant
    filter on `briefings` — under the service role it reads whichever row
    carries the id, and under a reader's own RLS it reads every row that
    reader's memberships admit. Every read of the literal table names both."""
    reads = _briefings_calls(("select",))
    # FLOOR (measured 2: `_stored_briefing_row`, GET /api/period). Fewer
    # means the census lost its subject (a rename, a table in a variable).
    assert len(reads) >= 2, "census found %d select call sites" % len(reads)
    for path, call in reads:
        where = "%s:%d" % (path.relative_to(REPO), call.lineno)
        filters = [k.value for k in call.keywords if k.arg == "filters"]
        assert len(filters) == 1 and isinstance(filters[0], ast.Dict), "%s: no literal filters" % where
        keys = _dict_keys(filters[0])
        assert "org_id" in keys and "period_id" in keys, "%s filters on %s" % (where, keys)


def _typescript_code(source: str) -> str:
    """`source` without its comments — `/* … */` blocks and `//` lines (the
    predicate's file explains the retired phrases in comments; the census
    reads CODE)."""
    without_blocks = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return "\n".join(line.split("//", 1)[0] for line in without_blocks.splitlines())


def test_census_the_browsers_failure_text_predicate_holds_no_phrase_searched_inside_the_body():
    """The browser carries the TWIN of the text predicate
    (frontend/lib/briefingDefinition.ts `isUnusableNarrative`): it runs on
    the body the engine served as usable. Until 2026-10-03 it searched the
    provider's phrases anywhere in the body, so a briefing this engine now
    serves as prose ("… the supplier's credit balance is too low …") would
    still be hidden by the page. Its behaviour is gated in vitest
    (components/cfo/__tests__/briefingHeaderPolicy.test.tsx); this census
    keeps the retired phrases from coming back into its CODE, and holds its
    anchored heads to the ones the engine's predicate reads."""
    path = REPO / "frontend" / "lib" / "briefingDefinition.ts"
    code = _typescript_code(path.read_text("utf-8"))
    # FLOOR: this IS the predicate's file, and comments were stripped, not code.
    assert "export function isUnusableNarrative" in code, "the browser predicate moved"
    assert "[NARRATIVE_UNAVAILABLE]" in code
    for phrase in ("credit balance", "invalid_request_error", "authentication_error"):
        assert phrase not in code, "the browser predicate names %r again" % phrase
    # Every regex literal of the file that names a failure head is anchored.
    heads = ("narrative unavailable", "Error code", "Set ANTHROPIC_API_KEY",
             "anthropic SDK not installed", "The briefing was withheld")
    literals = re.findall(r"/((?:\\.|[^/\\\n])+)/[a-z]*", code)
    naming = [rx for rx in literals if any(h.lower() in rx.lower() for h in heads)]
    assert naming, "no regex literal names a failure head: the census lost its subject"
    named = " ".join(naming).lower()
    assert all(h.lower() in named for h in heads), naming
    for rx in naming:
        assert rx.startswith("^"), "a failure head is searched anywhere in the body: /%s/" % rx


#: The only functions that may name a stale column: the two marker writers
#: (a SEPARATE best-effort update — SPEC D7) and the one reader.
_STALE_COLUMN_HOLDERS = ("_mark_briefing_stale", "_clear_briefing_stale", "served_briefing")


def _stale_column_mentions(tree: ast.AST) -> List[Tuple[Optional[str], int]]:
    """(innermost enclosing function, line) of every place the source names
    a stale column: a string constant CONTAINING the name (a dict key, a
    `columns="…"` list, a filter) or a keyword argument spelled with it.
    Docstrings are prose and are left out."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                docstrings.add(id(first.value))
    found: List[Tuple[Optional[str], int]] = []

    def _walk(node: ast.AST, holder: Optional[str]) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            holder = node.name
        if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
                and any(column in node.value for column in STALE_COLUMNS)):
            found.append((holder, node.lineno))
        if isinstance(node, ast.keyword) and node.arg in STALE_COLUMNS:
            found.append((holder, node.value.lineno))
        for child in ast.iter_child_nodes(node):
            _walk(child, holder)

    _walk(tree, None)
    return found


def test_census_the_stale_columns_are_named_only_by_the_marker_writers_and_the_reader():
    """The call-site censuses above read `<client>.<method>("briefings", …)`
    with the table as a positional literal. This one needs no call shape: a
    writer that reaches the columns through `upsert(table="briefings",
    rows={…})`, a table held in a variable, a `dict(stale_since=…)` or a new
    module names the column SOMEWHERE — and the only places allowed to are
    the two marker writers and the reader."""
    files = sorted(ENGINE_SRC.rglob("*.py"))
    assert len(files) > 100, "the census walked %d files of src/engine" % len(files)
    inside: Dict[str, int] = dict((name, 0) for name in _STALE_COLUMN_HOLDERS)
    outside: List[str] = []
    for path in files:
        source = path.read_text("utf-8")
        if not any(column in source for column in STALE_COLUMNS):
            continue
        for holder, lineno in _stale_column_mentions(ast.parse(source)):
            if holder in inside:
                inside[holder] += 1
            else:
                outside.append("%s:%d (in %s)" % (path.relative_to(REPO), lineno, holder or "module scope"))
    # FLOOR (measured 8: three in the marker, two in the clear, three in the
    # reader). Fewer than five, or a holder that names none, means the
    # census lost its subject (a rename) and proves nothing.
    assert sum(inside.values()) >= 5 and all(inside.values()), inside
    assert outside == [], "a stale column is named outside the marker writers and the reader: %s" % outside


#: Fragments of every failure text a branch of the narrator can return.
_FAILURE_LITERALS = ("NARRATIVE_UNAVAILABLE", "Narrative unavailable", "Set ANTHROPIC_API_KEY",
                     "anthropic SDK not installed", "The briefing was withheld")
_WRITERS = ("stage_persist_narrative", "regenerate_briefing", "_finalize_same_month_takeover")


def _string_literals(fn: ast.FunctionDef) -> List[str]:
    docstring = ast.get_docstring(fn, clean=False)
    return [c.value for c in ast.walk(fn)
            if isinstance(c, ast.Constant) and isinstance(c.value, str) and c.value != docstring]


def test_census_no_writer_holds_a_failure_text_of_its_own():
    """A writer names the neutral sentinel through the module constant; a
    failure sentence spelled inside a writer is a text about to be stored."""
    tree = ast.parse(PIPELINE_PY.read_text("utf-8"))
    # FLOOR: the scanner sees string literals at all — the narrator holds the
    # failure texts (measured 6 literals).
    narrator = [s for s in _string_literals(_function(tree, "stage_narrate"))
                if any(f in s for f in _FAILURE_LITERALS)]
    assert len(narrator) >= 5, narrator
    for name in _WRITERS:
        held = [s for s in _string_literals(_function(tree, name)) if any(f in s for f in _FAILURE_LITERALS)]
        assert held == [], "%s spells a failure text: %r" % (name, held)


@pytest.mark.parametrize("branch", sorted(BRANCHES))
def test_a_first_analysis_whose_narration_failed_stores_only_the_neutral_sentinel(branch, monkeypatch):
    """Nothing to protect (no stored row): the REAL narrator's failure, handed
    to the REAL `stage_persist_narrative`, is stored as the sentinel —
    measured before the fix as the operator sentence, the reply fragment or
    "Narrative unavailable.", whichever branch failed."""
    kwargs, code, text = BRANCHES[branch]
    _install_provider(monkeypatch, **kwargs)
    narrated = _narrate()
    assert narrated.get("unavailable") == code and narrated["briefing"] == text
    double = _world()
    with RA.installed(double):
        P.stage_persist_narrative(dict(DOC), PID, narrated, [])
    rows = _briefing_rows(double)
    assert len(rows) == 1, rows
    assert rows[0]["body"] == "[NARRATIVE_UNAVAILABLE]", rows[0]["body"]
    assert rows[0]["period_id"] == PID and rows[0]["org_id"] == ORG
    # …and nothing of the failure is left anywhere in the row or on the wire.
    if text != "[NARRATIVE_UNAVAILABLE]":
        assert text not in json.dumps(rows[0], ensure_ascii=False)
    served = _served(double)
    assert served["body"] is None and served["unavailable"] is True
    # A neutral code. (WHICH one a sentinel row is served with is not ruled:
    # the row keeps no record of why its first narration failed.)
    assert served["unavailable_reason"] in CODES and served["stale"] is None
    assert text not in json.dumps(served, ensure_ascii=False)


@pytest.mark.parametrize("migration_applied", [True, False], ids=["migration_applied", "before_the_migration"])
def test_a_first_analysis_whose_narration_is_usable_stores_its_prose(migration_applied, monkeypatch):
    """The positive control — and, before the migration, the dynamic proof
    that the pipeline's briefing upsert names no stale column."""
    _install_provider(monkeypatch, json.dumps({"briefing": GOOD_RO, "recommendations": []},
                                              ensure_ascii=False))
    narrated = _narrate(dict(SB.book("agras").doc, detected_language="ro"))
    assert "unavailable" not in narrated
    double = _world(migration_applied=migration_applied)
    with RA.installed(double):
        P.stage_persist_narrative(dict(DOC, detected_language="ro"), PID, narrated, [])
    rows = _briefing_rows(double)
    assert len(rows) == 1 and rows[0]["body"] == GOOD_RO, rows
    served = _served(double)
    assert served["body"] == GOOD_RO and served["unavailable"] is False and served["stale"] is None
    assert served["language"] == "ro"


@pytest.mark.parametrize("branch", sorted(BRANCHES))
def test_a_failed_regenerate_with_nothing_stored_writes_no_row(branch, monkeypatch):
    """Measured before the fix: with no API key the route stored "Set
    ANTHROPIC_API_KEY on the backend to enable AI narrative." as the
    period's briefing and answered ok: true."""
    kwargs, code, _text = BRANCHES[branch]
    _install_provider(monkeypatch, **kwargs)
    double = _world()
    before = _store(double)
    assert "briefings" not in before and before["financial_periods"], sorted(before)
    resp = _regenerate(double, {"intent": "user"})
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert answer["ok"] is False and answer["regenerated"] is False
    assert answer["reason"] == code
    # Truthful (owner ruling 2026-10-03): there is no briefing, so there is
    # no stale briefing. (SPEC D6a's literal `stale: true` was pinned here.)
    assert answer["stale"] is False, answer
    assert answer["briefing"] is None and answer["briefing_length"] == 0
    assert _briefing_rows(double) == []
    assert _store(double) == before, "a failed regenerate changed the store"
    assert _get_period(double)["briefing"] is None


# ══ S7 — the migration ════════════════════════════════════════════════════

def test_the_stale_migration_adds_both_columns_idempotently_and_reloads_the_schema_cache():
    raw = STALE_MIGRATION.read_text("utf-8")
    sql = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())  # comments are not DDL
    statements = [s for s in sql.split(";")
                  if re.search(r"alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?briefings\b", s, re.I)]
    assert statements, "no `alter table briefings` statement outside comments"
    ddl = " ".join(statements)
    assert re.search(r"add\s+column\s+if\s+not\s+exists\s+stale_since\s+timestamptz\b", ddl, re.I), ddl
    assert re.search(r"add\s+column\s+if\s+not\s+exists\s+stale_reason\s+text\b", ddl, re.I), ddl
    # Every `add column` of the file is idempotent (a bare one fails a re-run).
    assert len(re.findall(r"add\s+column\b", ddl, re.I)) == len(
        re.findall(r"add\s+column\s+if\s+not\s+exists\b", ddl, re.I)) == 2
    # Additive and optional: nothing is dropped, nothing made mandatory.
    assert not re.search(r"\bdrop\b|\bnot\s+null\b", sql, re.I), "the migration is not purely additive"
    # The LAST EXECUTABLE statement is the schema-cache reload — read from the
    # comment-stripped text (a commented-out NOTIFY is not a NOTIFY), in
    # whatever case SQL allows.
    executable = [s.strip() for s in sql.split(";") if s.strip()]
    assert " ".join(executable[-1].lower().split()) == "notify pgrst, 'reload schema'", executable[-1]
    # …and it is the file the tenancy double learns the columns from.
    assert set(STALE_COLUMNS) <= set(RA.migration_columns()["briefings"])


# ══ S8 — the post-deploy probe still reaches the verifier ═════════════════

def _probe_script() -> Any:
    spec = importlib.util.spec_from_file_location("_check_deployed_routes_b21f", str(PROBE_SCRIPT))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # no network at import: `main()` is guarded
    return module


class _WireResponse:
    """What `urllib.request.urlopen` hands back for a 2xx/3xx answer, as far
    as the script's `probe()` uses it (`with … as r`, `r.status`, `r.read`)."""

    def __init__(self, status: int, payload: bytes) -> None:
        self.status = status
        self._payload = io.BytesIO(payload)

    def __enter__(self) -> "_WireResponse":
        return self

    def __exit__(self, *_exc: Any) -> None:
        return None

    def read(self, amount: int = -1) -> bytes:
        return self._payload.read(amount)


def _urlopen_into(client: TestClient, sent: List[Dict[str, Any]]) -> Any:
    """A stand-in for `urllib.request.urlopen` that carries the Request the
    SCRIPT built — method, path, headers and body bytes exactly as built —
    into the real app, and answers as urllib does: a response for < 400, an
    `HTTPError` for the rest. It adds the ONE thing urllib's own handler
    adds on the wire: a body sent without a Content-Type goes out as
    `application/x-www-form-urlencoded` (AbstractHTTPHandler.do_request_)."""

    def _urlopen(request: Any, timeout: Any = None) -> Any:
        headers = dict((name.lower(), value) for name, value in request.header_items())
        if request.data is not None and "content-type" not in headers:
            headers["content-type"] = "application/x-www-form-urlencoded"
        url = urllib.parse.urlsplit(request.full_url)
        sent.append({"method": request.get_method(), "path": url.path, "headers": dict(headers),
                     "data": request.data})
        answer = client.request(request.get_method(), url.path, headers=headers, content=request.data)
        if answer.status_code >= 400:
            raise urllib.error.HTTPError(request.full_url, answer.status_code, answer.reason_phrase,
                                         None, io.BytesIO(answer.content))
        return _WireResponse(answer.status_code, answer.content)

    return _urlopen


def test_the_post_deploy_probe_posts_the_explicit_body_and_reaches_the_verifier(monkeypatch):
    """scripts/check_deployed_routes.py exists to reach `_org.verified_user_id`
    with an unsigned bearer (the 2026-09-06 outage). The regenerate route now
    has a body model: a probe the model refuses is answered 422 BEFORE the
    verifier — a refusal the script accepts, with the verifier unprobed.

    The script's OWN `probe()` is driven (its Request, its json.dumps, its
    headers), not a re-post of its body through the test client: a change
    to how the body goes on the wire is a change this must see."""
    script = _probe_script()
    probes = [p for p in script.PROBES if "/briefing/regenerate" in p[1]]
    assert len(probes) == 1, probes
    method, path, body = probes[0]
    assert method == "POST"
    assert body == {"intent": "user"}, body

    # A SPY on the verifier, not a stub: the real function still decides.
    examined: List[str] = []
    real_verifier = _org.verified_user_id

    def _spy(jwt: str, *a: Any, **k: Any) -> Any:
        examined.append(jwt)
        return real_verifier(jwt, *a, **k)

    monkeypatch.setattr(_org, "verified_user_id", _spy)
    double = _world()
    sent: List[Dict[str, Any]] = []
    with RA.installed(double):
        client = TestClient(_app(), raise_server_exceptions=False)
        monkeypatch.setattr(script.urllib.request, "urlopen", _urlopen_into(client, sent))
        code, text = script.probe("http://testserver", method, path, body)
        seen_by_the_probe = list(examined)
        del examined[:]
        code_of_an_empty_body, _text = script.probe("http://testserver", method, path, {})
    # The request the SCRIPT built is what reached the app.
    assert len(sent) == 2 and sent[0]["method"] == "POST" and sent[0]["path"] == path, sent
    assert json.loads(sent[0]["data"].decode("utf-8")) == {"intent": "user"}
    assert sent[0]["headers"]["authorization"] == "Bearer " + script.JUNK_BEARER
    # The verifier answered: the unsigned token was examined and refused.
    assert code == 401, (code, text)
    assert seen_by_the_probe == [script.JUNK_BEARER], seen_by_the_probe
    assert code in script.REFUSALS
    # The control: this app DOES tell the two apart — an empty body is
    # refused by the body model and the verifier never sees the token.
    assert code_of_an_empty_body == 422, code_of_an_empty_body
    assert examined == [], examined
    assert double.calls == [], "the probe reached the database"
