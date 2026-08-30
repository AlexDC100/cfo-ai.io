"""THE CAPSULE — GATES C1-C9, the ENGINE half.

The gates lane owns no product code. It owns the proof that the product
code cannot do the thing it promises not to do. Every gate below has a
PLANT — an edit that makes the defect real — which was applied, observed
to trip this suite, and reverted. The exact plant, the exact text the
gate emits, and the revert are recorded in
``design_review/capsule/GATES.md``; a gate whose plant was never run is
a gate nobody has proven is wired to anything.

WHAT LIVES HERE, AND WHY IT IS NOT THE TOOL LANE'S SUITE

``tests/engine/test_capsule_tools.py`` (the ground lane) proves the tool
layer BEHAVES: the right value, the right refusal, the right limitation.
This file proves the SURFACE cannot misbehave, from the outside:

  C1-E  THE LANGUAGE CHANNEL CARRIES NO FIGURES. Everything the model
        will ever read as PROSE (gap detail/fix, limitation
        detail/alternative, notes, row prose fields, ``ToolMoney.scope``)
        is swept for a numeral that is a FIGURE rather than an
        IDENTIFIER. A model that is handed "roughly 7,692,203" in a
        sentence will hand it back, and no placeholder discipline
        downstream can undo that. Figures travel as typed values and
        as ``facts`` — never inside a string.
  C2-E  READ-ONLY, THREE LAYERS DEEPER THAN THE REGISTRY. A static
        source tripwire over the surface's own files (no mutating HTTP
        verb, no client write call, no mutation-named public callable),
        a live census of every route the router actually mounts, and a
        sweep of the JSON handed to the model as its tool definitions.
  C3-E  GROUNDING AT THE SOURCE. Every value the surface can emit
        carries provenance naming the period, the entity, the served
        tier and the snapshot. The DOM half of C3 is
        ``e2e/design/capsule.spec.ts``; a figure cannot be traceable in
        the DOM if it was never traceable here.
  C5-E  MISSING-DATA HONESTY, WITH AN ESTIMATE PLANTED. A neighbouring
        period is the single most tempting substitute in this product,
        so the plant is exactly that: an accessor monkeypatched to
        answer from the month next door. The gate catches it on a
        property (a refusal carries no value, and no number in the
        answer belongs to another period), not on a string.
  C6-E  UNIT LAW AT THE PRODUCER. There is no display-currency input to
        reach for: the payload for a period is identical however the
        reader has their toggle set, ratios are computed on native
        operands and are invariant across a currency twin, and money
        differs only in its ``currency`` label.
  C9-E  RETRIEVAL LATENCY, MEASURED. Retrieval happens BEFORE
        generation, so it is inside the first-token budget. The numbers
        this prints are the ones reported — not the target.

C4 (router accuracy), C7 (degraded parity) and C8 (header budget) are
frontend laws and live in ``frontend/lib/__tests__/capsuleGates.test.ts``
and ``e2e/design/capsule.spec.ts``.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import importlib.util
import json
import re
import statistics
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import pytest

from engine.api import _capsule_tools as CT
from engine.api import _ratio_units

REPO = Path(__file__).resolve().parents[2]


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# The REAL composition chain (TB rows -> parse -> assemble), the same one
# the tool lane and the facts-gateway suite use. Nothing here hand-writes
# an envelope: a double would keep this whole file green while the
# surface produced nothing.
_trec = _load_by_path(
    "reconciliation_fixture_builders",
    Path(__file__).resolve().parent / "test_reconciliation.py",
)
_row = _trec._row
_assembled_for = _trec._assembled_for


# ══════════════════════════════════════════════════════════════════════
# Fixture book
# ══════════════════════════════════════════════════════════════════════

DEC_ROWS = [
    _row("212", sf_d=2500.00),
    _row("5121", sf_d=1000.00),
    _row("461", sf_d=400.00),
    _row("1012", sf_c=3400.00),
    _row("401", sf_c=500.00),
    _row("707", r_c=9000.00, st_c=9000.00),
    _row("607", r_d=6000.00, st_d=6000.00),
]

NOV_ROWS = [
    _row("212", sf_d=2500.00),
    _row("5121", sf_d=800.00),
    _row("461", sf_d=400.00),
    _row("1012", sf_c=3200.00),
    _row("401", sf_c=500.00),
    _row("707", r_c=7000.00, st_c=7000.00),
    _row("607", r_d=5000.00, st_d=5000.00),
]


def _period(pack, rows: List[Dict[str, float]], *, period_id: str,
            label: str, entity_id: str = "org-1", currency: str = "RON",
            period_end: str = "2024-12-31") -> "CT.PeriodRef":
    assembled = _assembled_for(pack, rows)
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-%s" % period_id,
        "content_hash": "sha256-%s" % period_id,
        "written_at": "2026-08-30T00:00:00+00:00",
    }
    accounts = tuple(
        CT.AccountRow(
            code=str(li.get("ro_account_code") or ""),
            name=str(li.get("ro_account_name") or ""),
            amount_minor=int(round(float(li.get("amount") or 0) * 100)),
            currency=currency,
            statement=str(li.get("statement") or ""),
            bucket=str(li.get("bucket") or ""),
        )
        for li in assembled["lineItems"]
        if li.get("ro_account_code")
    )
    return CT.PeriodRef(
        period_id=period_id, label=label, entity_id=entity_id,
        currency=currency, period_end=period_end,
        envelope=envelope, statements=assembled["statements"],
        accounts=accounts, snapshot_id="sha256-%s" % period_id,
    )


@pytest.fixture()
def dec_period(pack):
    return _period(pack, DEC_ROWS, period_id="p-dec", label="December 2024")


@pytest.fixture()
def nov_period(pack):
    return _period(pack, NOV_ROWS, period_id="p-nov", label="November 2024",
                   period_end="2024-11-30")


@pytest.fixture()
def eur_twin(pack):
    """THE CURRENCY TWIN (C6). Byte-identical trial-balance rows, the
    same entity, the same fiscal label, declared in EUR. Every ratio
    must be identical to its RON twin's; every money value must differ
    ONLY in its currency label. This is the producer-side statement of
    "identical in RON and EUR except for presentation".

    The label is deliberately the SAME string as the RON period's: the
    twins live in separate contexts, and an identical label is what lets
    C6 compare the two payloads byte for byte instead of eyeballing
    fields.
    """
    return _period(pack, DEC_ROWS, period_id="p-dec-eur",
                   label="December 2024", currency="EUR")


@pytest.fixture()
def empty_period():
    """A period row that exists with NO attached file — the case an
    estimate is most tempting for, and the C5 plant's target."""
    return CT.PeriodRef(period_id="p-oct", label="October 2024",
                        entity_id="org-1", currency="RON")


@pytest.fixture()
def ctx(dec_period, nov_period, empty_period):
    return CT.CapsuleContext(
        entity_id="org-1",
        periods=(dec_period, nov_period, empty_period),
        benchmarks=(
            CT.BenchmarkStat(peer_group="food_manufacturing",
                             metric="ebitda_margin",
                             unit=_ratio_units.UNIT_PERCENT,
                             p25=0.06, p50=0.10, p75=0.14,
                             sample_size=41, source="RO SME panel",
                             as_of="2025"),
            CT.BenchmarkStat(peer_group="niche_group", metric="ebitda_margin",
                             unit=_ratio_units.UNIT_PERCENT,
                             p25=0.01, p50=0.02, p75=0.03,
                             sample_size=3, source="RO SME panel",
                             as_of="2025"),
        ),
        help_topics=(
            CT.HelpTopic(topic_id="upload_tb", title_key="help.upload.title",
                         body_key="help.upload.body", route="/dashboard",
                         keywords=("upload", "trial balance", "balanta")),
        ),
    )


# ══════════════════════════════════════════════════════════════════════
# THE PROVOCATION MATRIX
# ══════════════════════════════════════════════════════════════════════
#
# Every gate below runs over the SAME matrix, because a law that holds
# on the happy path and leaks on the fifth refusal is not a law. Each
# entry is (tool, args): the eight tools crossed with present data,
# absent data, absent periods, absent metrics, misaligned comparisons,
# thin samples, bad arguments and a name that is not a tool at all.

PROVOCATIONS = (
    ("get_facts", {"metric": "total_assets", "period": "December 2024"}),
    ("get_facts", {"metric": "current_ratio", "period": "December 2024"}),
    ("get_facts", {"metric": "equity_ratio", "period": "p-dec"}),
    ("get_facts", {"metric": "net_margin", "period": "p-dec"}),
    ("get_facts", {"metric": "revenue", "period": "November 2024"}),
    ("get_facts", {"metric": "total_assets", "period": "October 2024"}),
    ("get_facts", {"metric": "total_assets", "period": "March 2019"}),
    ("get_facts", {"metric": "gross_margin_ish", "period": "p-dec"}),
    ("get_facts", {}),
    ("compare_periods", {"metrics": ["total_assets", "revenue"],
                         "p1": "November 2024", "p2": "December 2024"}),
    ("compare_periods", {"metrics": ["total_assets"], "p1": "October 2024",
                         "p2": "December 2024"}),
    ("compare_periods", {"metrics": ["total_assets"], "p1": "p-dec"}),
    ("get_account", {"code": "461", "period": "p-dec"}),
    ("get_account", {"code": "5", "period": "p-dec"}),
    ("get_account", {"code": "9999", "period": "p-dec"}),
    ("get_account", {"code": "461", "period": "October 2024"}),
    ("list_findings", {"period": "p-dec"}),
    ("list_findings", {"period": "October 2024"}),
    ("get_benchmark", {"peer_group": "food_manufacturing",
                       "metric": "ebitda_margin"}),
    ("get_benchmark", {"peer_group": "niche_group",
                       "metric": "ebitda_margin"}),
    ("get_benchmark", {"peer_group": "shipbuilding", "metric": "ebitda_margin"}),
    ("run_scenario_preview", {"drivers": [{"metric": "revenue", "mode": "pct",
                                           "value": 10}],
                              "period": "p-dec"}),
    ("run_scenario_preview", {"drivers": [{"metric": "headcount",
                                           "mode": "pct", "value": 10}],
                              "period": "p-dec"}),
    ("run_scenario_preview", {"drivers": [], "period": "October 2024"}),
    ("get_public_company", {"entity": "NOSUCH"}),
    ("search_help", {"topic": "balanță"}),
    ("search_help", {"topic": "quantum accounting"}),
    ("search_help", {"topic": "upload", "period": "p-dec"}),
    ("set_period_status", {"status": "approved"}),
    ("", {}),
)


def _results(ctx: "CT.CapsuleContext") -> List[Tuple[str, Dict[str, Any],
                                                     "CT.ToolResult"]]:
    return [(tool, args, CT.dispatch(tool, args, ctx))
            for tool, args in PROVOCATIONS]


# ══════════════════════════════════════════════════════════════════════
# C1-E — the language channel carries no FIGURES
# ══════════════════════════════════════════════════════════════════════
#
# The distinction the scanner draws, and the whole of C1's engine half:
#
#   IDENTIFIER   names a thing the reader can look up — a period label
#                ("December 2024"), an account code ("461"), a served
#                line id ("I18"), a contract version ("ct1"). Prose may
#                carry these; they are not claims about magnitude.
#   FIGURE       states a quantity — separators, decimals, a currency or
#                a percent beside it, or simply a number that names
#                nothing in the context. Prose may NEVER carry one.
#
# The model reads prose. A figure inside prose is a figure the model can
# repeat without a placeholder, and C1's whole discipline downstream
# assumes the model was never given one.

_DIGIT_RUN = re.compile(r"\d[\d.,\u00a0\u202f ]*\d|\d")
#: A digit run with a separator BETWEEN digits is a figure, always.
_GROUPED = re.compile(r"\d[.,\u00a0\u202f ]\d")
#: A currency or percent beside a digit run is a figure, always.
_CURRENCY_ADJACENT = re.compile(
    r"(?:(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£)\s*\d)"
    r"|(?:\d\s*(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£|%|pp))",
    re.IGNORECASE,
)
#: Words that promise a number the surface does not have. A refusal that
#: hedges is an estimate wearing a refusal's clothes.
_ESTIMATE_WORDS = (
    "approx", "roughly", "estimate", "estimated", "estimation", "circa",
    "ballpark", "give or take", "order of magnitude", "aproximativ",
    "aprox", "estimativ", "cam ", "probably", "presumably", "we assume",
    "assumed to be", "should be around", "in the region of",
)


def _fold(text: Any) -> str:
    raw = "" if text is None else str(text)
    decomposed = unicodedata.normalize("NFD", raw)
    return "".join(ch for ch in decomposed
                   if not unicodedata.combining(ch)).lower()


def _echoed_tokens() -> List[str]:
    """The surface may repeat what the USER typed. "No period called
    'March 2019'" is an echo, not a fabricated figure, and so is "ask
    for the shorter prefix 999" when the user asked about 9999 — a
    prefix of their own input. Anything derived from the arguments in
    the matrix is licensed; nothing else is."""
    out = set()  # type: set
    for _tool, args in PROVOCATIONS:
        for value in _flatten_args(args):
            out.add(value)
            for run in _DIGIT_RUN.findall(value):
                for length in range(2, len(run) + 1):
                    out.add(run[:length])
    return [t for t in out if any(ch.isdigit() for ch in t)]


def _flatten_args(node: Any) -> List[str]:
    if isinstance(node, dict):
        out = []  # type: List[str]
        for key, val in node.items():
            out.append(str(key))
            out.extend(_flatten_args(val))
        return out
    if isinstance(node, (list, tuple)):
        out = []
        for val in node:
            out.extend(_flatten_args(val))
        return out
    return [str(node)]


def _identifier_tokens(ctx: "CT.CapsuleContext",
                       extra: Iterable[str] = ()) -> List[str]:
    """Every digit-bearing string the surface is ALLOWED to name in
    prose, built from the context and the caller's own words rather than
    hard-coded — so a fixture change can never quietly widen the
    licence."""
    tokens = set(_echoed_tokens())  # type: set
    for period in ctx.periods:
        for value in (period.label, period.period_id, period.period_end,
                      period.snapshot_id, period.entity_id):
            if value:
                tokens.add(str(value))
        for account in period.accounts:
            if account.code:
                tokens.add(account.code)
    for bench in ctx.benchmarks:
        for value in (bench.peer_group, bench.metric, bench.as_of):
            if value:
                tokens.add(str(value))
    for topic in ctx.help_topics:
        tokens.add(topic.topic_id)
        tokens.update(topic.keywords)
    tokens.update(CT.TOOL_ALLOWLIST)
    tokens.update(CT.METRICS.keys())
    tokens.add(CT.CAPSULE_TOOLS_VERSION)
    tokens.update(str(x) for x in extra)
    # Longest first: stripping "December 2024" must happen before "2024".
    return sorted((t for t in tokens if any(ch.isdigit() for ch in t)),
                  key=len, reverse=True)


_SEPARATORS = ".,\u00a0\u202f "


def _strip_allowed(text: str, allowed: Sequence[str]) -> str:
    """Remove an allowed IDENTIFIER, but only where it stands on its own
    — never where it is part of a longer number. Stripping runs BEFORE
    the hard rules, so a licensed identifier that happens to contain a
    separator is not mistaken for a quantity, while a longer number that
    merely starts with one still is."""
    out = text
    for token in sorted([t for t in allowed if t], key=len, reverse=True):
        start = 0
        while True:
            i = out.find(token, start)
            if i < 0:
                break
            end = i + len(token)
            before = out[i - 1] if i else ""
            after = out[end] if end < len(out) else ""
            before_before = out[i - 2] if i > 1 else ""
            after_after = out[end + 1] if end + 1 < len(out) else ""
            glued = (
                before.isdigit() or after.isdigit()
                or (before in _SEPARATORS and before_before.isdigit())
                or (after in _SEPARATORS and after_after.isdigit())
            )
            if glued:
                start = i + 1
                continue
            out = out[:i] + (" " * len(token)) + out[end:]
            start = end
    return out


def figures_in(text: Any, allowed: Sequence[str]) -> List[str]:
    """Digit runs in ``text`` that state a QUANTITY. Empty list = clean.

    This is the one definition of "figure" in the Capsule gates; the
    frontend half (``capsuleGates.test.ts``) mirrors it in TypeScript
    and ``design_review/capsule/GATES.md`` states it in prose. Three
    files, one rule — deliberately, because the rule is the gate.
    """
    raw = "" if text is None else str(text)
    if not raw:
        return []
    stripped = _strip_allowed(raw, allowed)
    hard = []  # type: List[str]
    for match in _GROUPED.finditer(stripped):
        hard.append(match.group(0))
    for match in _CURRENCY_ADJACENT.finditer(stripped):
        hard.append(match.group(0))
    if hard:
        return hard

    out = []  # type: List[str]
    for match in _DIGIT_RUN.finditer(stripped):
        start_i, end_i = match.start(), match.end()
        before = stripped[start_i - 1] if start_i else ""
        after = stripped[end_i] if end_i < len(stripped) else ""
        # Letter-attached digits are identifiers: I18, ct1, v1, sha256.
        if (before.isalpha() or before == "_"
                or after.isalpha() or after == "_"):
            continue
        out.append(match.group(0))
    return out


#: Rows whose prose is ENGINE-AUTHORED NARRATIVE (a finding). These are
#: not swept by C1-E-a: a finding is a rendered claim, and the law that
#: governs it is C1-E-b below — it must ship with the placeholder
#: template and the bindable facts that let the answer lane RE-RENDER it
#: rather than quote it. Quoting a rendered body to the model is exactly
#: how a figure escapes the placeholder discipline, so the template's
#: existence is the gate.
NARRATIVE_ROW_KINDS = ("finding",)

#: KNOWN VIOLATIONS — a ratchet, not an exemption (the convention
#: `scripts/check_narrative_units.mjs` established). Each entry names a
#: real figure in the language channel that this lane does not own. The
#: fix is the same in both cases: carry the count as a declared fact and
#: state the sentence as a template, the way findings already do.
#: Recorded as cross-lane needs in design_review/capsule/GATES.md §C1-E.
#: A NEW violation fails the gate; a FIXED one prints a notice so the
#: list can shrink without this file going red on someone else's
#: improvement.
QUARANTINE = (
    # engine/api/findings — the check-count note.
    ("list_findings", "notes[", r"^\d+ detector check\(s\) ran on "),
    # engine/api/_capsule_tools.get_benchmark — the thin-sample sentence.
    ("get_benchmark", "limitation.detail[sample_size]",
     r"peer\(s\) for .*below the \d+ needed"),
    # engine/api/_capsule_tools.get_account — the prefix-expansion note.
    ("get_account", "notes[", r"^\d+ sub-accounts of .* listed individually"),
)


def _quarantined(tool: str, where: str, text: str) -> bool:
    for q_tool, q_where, pattern in QUARANTINE:
        if tool == q_tool and where.startswith(q_where) \
                and re.search(pattern, text):
            return True
    return False


def _prose_of(result: "CT.ToolResult") -> List[Tuple[str, str]]:
    """(where, text) for every TOOL-AUTHORED string the model reads as
    language. Narrative rows are excluded — see NARRATIVE_ROW_KINDS."""
    out = []  # type: List[Tuple[str, str]]
    for gap in result.gaps:
        out.append(("gap.detail[%s]" % gap.code, gap.detail))
        out.append(("gap.fix[%s]" % gap.code, gap.fix))
    for lim in result.limitations:
        out.append(("limitation.detail[%s]" % lim.rule, lim.detail))
        out.append(("limitation.alternative[%s]" % lim.rule, lim.alternative))
    for i, note in enumerate(result.notes):
        out.append(("notes[%d]" % i, note))
    for value in result.values:
        scope = getattr(value, "scope", "")
        if scope:
            out.append(("value.scope[%s]" % getattr(value, "fact", "?"), scope))
    for row in result.rows:
        if row.kind in NARRATIVE_ROW_KINDS:
            continue
        for key, val in (row.fields or {}).items():
            if isinstance(val, str):
                out.append(("row[%s].fields.%s" % (row.row_id, key), val))
        for money in row.money:
            if money.scope:
                out.append(("row[%s].money[%s].scope" % (row.row_id, money.fact),
                            money.scope))
    return out


def _narrative_rows(result: "CT.ToolResult") -> List["CT.ToolRow"]:
    return [r for r in result.rows if r.kind in NARRATIVE_ROW_KINDS]


def test_c1_no_figure_ever_reaches_the_language_channel(ctx):
    """THE GATE. Sweeps every prose string the surface can emit across
    the full provocation matrix.

    PLANT (design_review/capsule/GATES.md §C1-E): give ``_no_file_gap``
    a fabricated figure —
        detail="%s has no attached file (last known total 7,692,203 RON)."
    Emits:
        FIGURE IN THE LANGUAGE CHANNEL — get_facts gap.detail[no_source_file]
        carries ['7,692,203 R']: 'October 2024 has no attached file (last
        known total 7,692,203 RON).'
    """
    allowed = _identifier_tokens(ctx)
    violations = []  # type: List[str]
    hit_quarantine = set()  # type: set
    for tool, args, result in _results(ctx):
        for where, text in _prose_of(result):
            found = figures_in(text, allowed)
            if not found:
                continue
            if _quarantined(tool, where, text):
                hit_quarantine.add((tool, where.split("[")[0]))
                continue
            violations.append(
                "FIGURE IN THE LANGUAGE CHANNEL — %s %s carries %r: %r"
                % (tool, where, found, text))
    for q_tool, q_where, pattern in QUARANTINE:
        if (q_tool, q_where.split("[")[0]) not in hit_quarantine:
            print("\n[C1-E] NOTICE: quarantined violation no longer fires "
                  "(%s %s %r) — drop it from QUARANTINE."
                  % (q_tool, q_where, pattern))
    assert not violations, "\n".join(violations)


def test_c1_the_scanner_itself_catches_a_planted_figure(ctx):
    """A gate nobody has seen fail is a gate nobody has. The plant is
    executed here in-process, against the real prose the real surface
    emits, so the scanner's teeth are proven on every run rather than
    once in a changelog."""
    allowed = _identifier_tokens(ctx)
    real = CT.dispatch("get_facts",
                       {"metric": "total_assets", "period": "October 2024"},
                       ctx).gaps[0]
    assert figures_in(real.detail, allowed) == []

    planted = "%s (last known total 7,692,203 RON)." % real.detail
    assert figures_in(planted, allowed), "the scanner missed a fabricated total"
    # And the subtler shapes: a bare percentage, a hedged magnitude, a
    # decimal with no currency beside it.
    assert figures_in("Equity is 19.6% of total assets.", allowed)
    assert figures_in("December 2024 is about 40000 short.", allowed)
    assert figures_in("The ratio came out at 1.53.", allowed)
    # …and the identifiers it must NOT flag.
    assert figures_in("December 2024 has no attached file.", allowed) == []
    assert figures_in("Account 461 is not in this period.", allowed) == []
    assert figures_in("served envelope carries no I18 (tier=canonical_bs)",
                      allowed) == []


#: `{{money:fact}}` / `{{fact:fact}}` — the placeholder grammar the
#: renderer accepts (frontend/lib/narrativeMoney.tsx PLACEHOLDER_RX).
_PLACEHOLDER = re.compile(
    r"\{\{(money|fact|ratio|percent|days|count|score):([A-Za-z0-9_]+)"
    r"((?:\|[a-z0-9]+)*)\}\}")
#: A money figure in RENDERED prose: a currency code beside a number.
_RENDERED_MONEY = re.compile(
    r"(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£)\s*-?\d[\d.,   ]*"
    r"|-?\d[\d.,   ]*\s*(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£)",
    re.IGNORECASE)


def test_c1_narrative_rows_ship_a_template_the_answer_lane_can_rerender(ctx):
    """C1-E-b — the law for ENGINE-AUTHORED narrative.

    A finding's rendered body legitimately contains figures; it is a
    deterministic engine claim, not model output. What makes it safe to
    put in front of a model is that it arrives WITH its template and its
    facts, so the answer lane re-renders through the money path instead
    of quoting digits. This gate holds the template to the body:

      · every money figure in the rendered body has a placeholder in the
        template (a template that lags the body is precisely the 461
        defect — a figure rendered outside the money path);
      · every placeholder names a fact the row itself carries, with a
        declared unit;
      · the row states the currency its facts are denominated in.

    PLANT (§C1-E-b): drop one `{{money:…}}` from a finding's
    ``body_template`` while leaving the rendered body intact. Emits
        TEMPLATE LAGS THE BODY — finding concentration_related_party:
        3 money figure(s) rendered, 2 placeholder(s) in body_template
    """
    result = CT.dispatch("list_findings", {"period": "p-dec"}, ctx)
    rows = _narrative_rows(result)
    assert rows, "the fixture book surfaced no findings to gate"

    violations = []  # type: List[str]
    for row in rows:
        fields = row.fields or {}
        facts = fields.get("facts_cited") or {}
        units = fields.get("fact_units") or {}
        for key in ("title", "body"):
            rendered = str(fields.get(key) or "")
            template = str(fields.get(key + "_template") or "")
            if not rendered:
                continue
            if not template:
                violations.append(
                    "NO TEMPLATE — finding %s: %s is rendered prose with no "
                    "%s_template" % (row.row_id, key, key))
                continue
            money_figures = _RENDERED_MONEY.findall(rendered)
            placeholders = _PLACEHOLDER.findall(template)
            money_placeholders = [p for p in placeholders if p[0] == "money"]
            if len(money_placeholders) < len(money_figures):
                violations.append(
                    "TEMPLATE LAGS THE BODY — finding %s: %d money figure(s) "
                    "rendered, %d placeholder(s) in %s_template"
                    % (row.row_id, len(money_figures),
                       len(money_placeholders), key))
            for token, fact, _opts in placeholders:
                if fact not in facts:
                    violations.append(
                        "UNBINDABLE PLACEHOLDER — finding %s %s_template names "
                        "{{%s:%s}}, which is not in facts_cited"
                        % (row.row_id, key, token, fact))
                elif token == "fact" and not units.get(fact):
                    violations.append(
                        "UNDECLARED UNIT — finding %s cites %r with no unit; "
                        "the renderer refuses an inferred one"
                        % (row.row_id, fact))
        if _RENDERED_MONEY.search(str(fields.get("body") or "")):
            assert fields.get("source_currency"), (
                "finding %s renders money without naming its currency"
                % row.row_id)
    assert not violations, "\n".join(violations)


def test_c1_no_prose_hedges_a_number_it_does_not_have(ctx):
    """The estimate vocabulary. "roughly" is how a refusal becomes an
    estimate without a single digit changing hands."""
    violations = []  # type: List[str]
    for tool, _args, result in _results(ctx):
        for where, text in _prose_of(result):
            folded = _fold(text)
            for word in _ESTIMATE_WORDS:
                if word in folded:
                    violations.append(
                        "HEDGE IN THE LANGUAGE CHANNEL — %s %s says %r: %r"
                        % (tool, where, word, text))
    assert not violations, "\n".join(violations)


def test_c1_every_number_in_a_payload_is_typed_not_prose(ctx):
    """The structural complement: a JSON payload's numbers live in typed
    fields (``amount_minor``, ``value``, ``facts``, percentile bands) and
    in NO string. Serialize, walk, and check every string leaf."""
    allowed = _identifier_tokens(ctx)
    string_keys_that_are_data = {"period_end", "as_of", "written_at",
                                 "content_hash", "snapshot_id", "line_id",
                                 "source_document_id", "id", "code",
                                 "period_id", "period_label", "entity_id",
                                 "from_period_id", "to_period_id",
                                 "profile_fingerprint", "profile_id"}
    violations = []  # type: List[str]

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key, val in node.items():
                walk(val, "%s.%s" % (path, key))
        elif isinstance(node, list):
            for i, val in enumerate(node):
                walk(val, "%s[%d]" % (path, i))
        elif isinstance(node, str):
            leaf = path.rsplit(".", 1)[-1].split("[")[0]
            if leaf in string_keys_that_are_data:
                return
            found = figures_in(node, allowed)
            if found:
                violations.append("%s carries %r: %r" % (path, found, node))

    for tool, _args, result in _results(ctx):
        payload = result.to_payload()
        # Narrative rows are governed by C1-E-b (template + facts), and
        # the quarantined notes by QUARANTINE — both above.
        payload["rows"] = [r for r in payload["rows"]
                           if r.get("kind") not in NARRATIVE_ROW_KINDS]
        payload["notes"] = [n for n in payload["notes"]
                            if not _quarantined(tool, "notes[", n)]
        payload["limitations"] = [
            l for l in payload["limitations"]
            if not _quarantined(tool, "limitation.detail[%s]" % l.get("rule"),
                                str(l.get("detail") or ""))]
        walk(payload, tool)
    assert not violations, "\n".join(violations)


# ══════════════════════════════════════════════════════════════════════
# C2-E — read-only, proven from outside the registry
# ══════════════════════════════════════════════════════════════════════

#: The files that ARE this surface on the engine side. A new one has to
#: be added here deliberately — which is the point.
SURFACE_SOURCES = ("src/engine/api/_capsule_tools.py",)

#: Route decorators that mutate. ``@router.get`` and ``@router.post`` are
#: the only two this surface may carry — POST because a tool call has a
#: body, not because it writes.
_MUTATING_DECORATOR = re.compile(
    r"@\w+\.(put|patch|delete|head_write|options_write)\s*\(")
#: Supabase / PostgREST write calls, in any client-variable spelling.
_CLIENT_WRITE = re.compile(
    r"\.\s*(insert|upsert|update|delete|rpc|execute_write|save|commit)\s*\(")


def _surface_text() -> List[Tuple[str, str]]:
    return [(rel, (REPO / rel).read_text(encoding="utf-8"))
            for rel in SURFACE_SOURCES]


def test_c2_no_mutating_route_or_client_write_in_the_surface_source():
    """STATIC TRIPWIRE — the cheapest layer, and the one that catches a
    write path that was never registered as a "tool" at all.

    PLANT (§C2-E-a): add to ``build_router``

        @router.delete("/api/capsule/period/{period_id}")
        def drop_period(period_id: str):
            return {"ok": True}

    Emits:
        MUTATING ROUTE — src/engine/api/_capsule_tools.py:1698
        @router.delete("/api/capsule/period/{period_id}")
    """
    violations = []  # type: List[str]
    for rel, text in _surface_text():
        for i, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if _MUTATING_DECORATOR.search(line):
                violations.append("MUTATING ROUTE — %s:%d %s"
                                  % (rel, i, stripped))
            if _CLIENT_WRITE.search(line):
                violations.append("CLIENT WRITE — %s:%d %s"
                                  % (rel, i, stripped))
    assert not violations, "\n".join(violations)


def test_c2_every_mounted_route_is_a_read(monkeypatch):
    """LIVE CENSUS — build the real router and enumerate what FastAPI
    actually mounted. A decorator the static pass never saw (registered
    through ``add_api_route``, say) still shows up here.

    PLANT (§C2-E-b): the same ``@router.delete`` emits
        WRITE METHOD MOUNTED — DELETE /api/capsule/period/{period_id}
    """
    router = CT.build_router()
    seen = []  # type: List[Tuple[str, str]]
    violations = []  # type: List[str]
    for route in router.routes:
        methods = sorted(getattr(route, "methods", None) or [])
        path = getattr(route, "path", "")
        for method in methods:
            seen.append((method, path))
            if method not in ("GET", "POST", "HEAD", "OPTIONS"):
                violations.append("WRITE METHOD MOUNTED — %s %s"
                                  % (method, path))
        if path and not path.startswith("/api/capsule"):
            violations.append("ROUTE OUTSIDE THE SURFACE — %s" % path)
    assert seen, "the capsule router mounted no routes at all"
    assert not violations, "\n".join(violations)


def test_c2_the_model_is_handed_no_tool_that_writes():
    """What the model actually receives as its tool definitions. Names,
    descriptions and parameter names all sweep clean of mutation verbs —
    a description that says "and marks it reviewed" is a prompt-level
    write invitation even when the callable is read-only."""
    schemas = CT.tool_schemas()
    assert [s["name"] for s in schemas] == list(CT.TOOL_ALLOWLIST)
    blob = json.dumps(schemas).lower()
    for verb in CT.WRITE_VERB_PREFIXES:
        bare = verb.rstrip("_")
        # The word, not the substring: "post" must not fire on "posted
        # to" inside a sentence about postings, but "post " as a verb of
        # its own is what we are looking for.
        assert not re.search(r"\b%ss?\b\s+(the|a|this|it|data|row|period)"
                             % re.escape(bare), blob), (
            "a tool schema handed to the model describes a %r" % bare)
    for schema in schemas:
        assert schema["read_only"] is True
        for param in schema["params"]:
            for verb in CT.WRITE_VERB_PREFIXES:
                assert not param["name"].lower().startswith(verb)


def test_c2_a_planted_write_tool_never_executes_through_the_dispatcher(ctx):
    """RUNTIME — the outside view of the ground lane's seam 3. What this
    adds: the planted callable is dispatched through the SAME matrix the
    other gates use, including with arguments that look plausible, and
    the refusal is checked to be a normal typed result rather than an
    exception the surface would have to render raw."""
    calls = []  # type: List[Any]

    def planted(tool_ctx, **kwargs):
        calls.append(kwargs)
        raise AssertionError("the planted write tool executed")

    rogue = dict(CT.TOOL_REGISTRY)
    rogue["set_period_status"] = CT.ToolSpec(
        name="set_period_status", fn=planted, description="plants a write",
        params=(CT.ToolParam("status", "string", True, ""),),
        returns="never")
    original = CT.TOOL_REGISTRY
    CT.TOOL_REGISTRY = rogue  # type: ignore[misc]
    try:
        for args in ({"status": "approved"}, {}, {"period": "p-dec"}):
            result = CT.dispatch("set_period_status", args, ctx)
            assert not result.ok
            assert result.values == () and result.rows == ()
            assert [g.code for g in result.gaps] == [CT.GAP_TOOL_NOT_ALLOWLISTED]
            assert result.to_payload()["read_only"] is True
    finally:
        CT.TOOL_REGISTRY = original  # type: ignore[misc]
    assert calls == [], "a planted write tool ran"


def test_c2_no_public_callable_in_the_surface_names_a_mutation():
    for name in dir(CT):
        if name.startswith("_") or not callable(getattr(CT, name)):
            continue
        lowered = name.lower()
        for verb in CT.WRITE_VERB_PREFIXES:
            assert not lowered.startswith(verb), (
                "public callable %r names a mutation" % name)


# ══════════════════════════════════════════════════════════════════════
# C3-E — grounding at the source
# ══════════════════════════════════════════════════════════════════════

#: Every value must name its entity and the served source it came from.
REQUIRED_PROVENANCE = ("entity_id", "source")
#: …and identify its period, either directly or as the two endpoints it
#: was derived between.
PERIOD_IDENTITY = (("period_id", "period_label"),
                   ("from_period_id", "to_period_id"))
#: …and anchor to a persisted snapshot, unless it DECLARES itself
#: derived — in which case the result must also carry at least one
#: directly-anchored value it was derived from. Nothing floats free.
ANCHORS = ("snapshot_id", "line_id")
DERIVED_MARKERS = ("basis", "preview", "from_period_id", "basis_metric")


def test_c3_every_value_carries_provenance_to_a_snapshot(ctx):
    """A figure that cannot name its period, its entity and its snapshot
    cannot be checked by the reader, and an unverifiable figure in a
    CFO's hands is worse than no figure.

    Two provenance shapes are legitimate and the gate knows the
    difference: a SERVED value anchors to a snapshot; a DERIVED value (a
    period-over-period delta, a what-if) says so and names what it was
    derived between — and cannot be the only thing in the result, so the
    anchored operands are always there to check it against.

    PLANT (§C3-E): return ``{}`` from ``_provenance``. Emits
        UNGROUNDED VALUE — get_facts total_assets: provenance missing
        ['entity_id', 'source']
    """
    violations = []  # type: List[str]
    checked = 0
    for tool, _args, result in _results(ctx):
        values = list(result.values) + [m for r in result.rows for m in r.money]
        anchored_in_result = [
            v for v in values
            if any((getattr(v, "provenance", None) or {}).get(a)
                   for a in ANCHORS)]
        for value in values:
            checked += 1
            prov = getattr(value, "provenance", None) or {}
            missing = [k for k in REQUIRED_PROVENANCE if not prov.get(k)]
            if missing:
                violations.append("UNGROUNDED VALUE — %s %s: provenance "
                                  "missing %r" % (tool, value.fact, missing))
                continue
            if not any(all(prov.get(k) for k in shape)
                       for shape in PERIOD_IDENTITY):
                violations.append(
                    "UNGROUNDED VALUE — %s %s: no period identity (neither "
                    "period_id+period_label nor from/to_period_id)"
                    % (tool, value.fact))
                continue
            if any(prov.get(a) for a in ANCHORS):
                continue
            if not any(prov.get(m) is not None for m in DERIVED_MARKERS):
                violations.append(
                    "UNGROUNDED VALUE — %s %s: no snapshot anchor and it does "
                    "not declare itself derived" % (tool, value.fact))
            elif not anchored_in_result:
                violations.append(
                    "UNGROUNDED VALUE — %s %s: derived, but the result carries "
                    "no anchored value to derive from" % (tool, value.fact))
    assert checked > 0, "the matrix produced no values to ground"
    assert not violations, "\n".join(violations)


def test_c3_the_fact_map_and_the_values_agree_exactly(ctx):
    """The ``{{money:FACT}}`` bridge. A placeholder binds against
    ``facts``; if that map and the typed values ever disagree, a figure
    in the DOM is provenanced to the wrong value — the worst failure
    mode this gate exists to prevent, because it looks correct."""
    for tool, _args, result in _results(ctx):
        payload = result.to_payload()
        facts = payload["facts"]
        units = payload["fact_units"]
        assert set(facts) == set(units), tool
        for value in result.values:
            assert value.fact in facts, "%s: %s not bindable" % (tool, value.fact)
            if isinstance(value, CT.ToolMoney):
                assert facts[value.fact] == value.amount_minor / 100.0
                assert units[value.fact] == _ratio_units.UNIT_MONEY
            else:
                assert facts[value.fact] == value.value
                assert units[value.fact] != _ratio_units.UNIT_MONEY
        for fact in facts:
            assert re.match(r"^[A-Za-z0-9_]+$", fact), (
                "%s: fact %r is not placeholder-safe" % (tool, fact))


def test_c3_a_refusal_grounds_nothing_and_binds_nothing(ctx):
    """The other half of grounding: when the answer is a gap, there must
    be nothing for a placeholder to bind to. An empty-but-present fact
    map is how a "0" appears in a sentence about a month with no file."""
    for tool, args in PROVOCATIONS:
        result = CT.dispatch(tool, args, ctx)
        if result.ok:
            continue
        payload = result.to_payload()
        assert payload["facts"] == {}, "%s %r" % (tool, args)
        assert payload["fact_units"] == {}, "%s %r" % (tool, args)
        assert payload["currency"] is None, "%s %r" % (tool, args)
        assert payload["values"] == [] and payload["rows"] == []


# ══════════════════════════════════════════════════════════════════════
# C5-E — missing-data honesty, with the estimate PLANTED
# ══════════════════════════════════════════════════════════════════════


def test_c5_absent_period_answers_with_the_gap_and_no_number(ctx, nov_period):
    """Every tool, asked about the month with no file. Each must refuse,
    name the month, name the fix — and never hand back a number that
    belongs to a month that does have one."""
    # Distinctive amounts only: "0" appears in every ISO date, and a
    # gate that fires on a substring of a timestamp teaches people to
    # ignore it.
    neighbours = set()  # type: set
    for metric in ("total_assets", "revenue", "equity", "net_result"):
        got = CT.dispatch("get_facts", {"metric": metric,
                                        "period": "November 2024"}, ctx)
        for value in got.values:
            for candidate in (getattr(value, "amount_minor", None),
                              getattr(value, "value", None)):
                if candidate and abs(candidate) >= 1000:
                    neighbours.add(candidate)
    assert neighbours, "the fixture book produced no neighbouring values"

    asked = 0
    for tool, args in (("get_facts", {"metric": "total_assets",
                                      "period": "October 2024"}),
                       ("get_account", {"code": "461",
                                        "period": "October 2024"}),
                       ("list_findings", {"period": "October 2024"}),
                       ("run_scenario_preview",
                        {"drivers": [{"metric": "revenue", "mode": "pct",
                                      "value": 10}],
                         "period": "October 2024"}),
                       ("compare_periods", {"metrics": ["total_assets"],
                                            "p1": "October 2024",
                                            "p2": "December 2024"})):
        asked += 1
        result = CT.dispatch(tool, args, ctx)
        assert not result.ok, "%s answered about a period with no file" % tool
        assert result.values == () and result.facts() == {}
        refusals = list(result.gaps) + list(result.limitations)
        assert refusals, "%s refused without saying why" % tool
        said = " ".join([getattr(r, "detail", "") for r in refusals]
                        + [getattr(r, "fix", "") for r in refusals]
                        + [getattr(r, "alternative", "") for r in refusals])
        assert "October 2024" in said, "%s: %r" % (tool, said)
        blob = json.dumps(result.to_payload())
        for number in neighbours:
            assert str(number) not in blob, (
                "%s leaked a neighbouring period's value %r" % (tool, number))
    assert asked == 5


def test_c5_a_planted_estimator_is_caught_by_this_suite(ctx, monkeypatch,
                                                        nov_period):
    """THE PLANT, executed. ``_resolve_period`` is monkeypatched to do
    the single most plausible wrong thing in this product: when the
    named month has no file, quietly answer from the month next door.

    Nothing else changes — the answer is well-formed, correctly typed,
    correctly provenanced to a real snapshot, and completely wrong about
    which month the reader asked for. This test asserts that the C5
    property above (a refusal, and no neighbour's number anywhere in the
    payload) is what fails, so the gate is provably wired to the defect
    and not merely to a string.
    """
    original = CT._resolve_period

    def substituting(context, ref):
        period, gap = original(context, ref)
        if period is not None and not period.has_source_file:
            for candidate in context.periods:
                if candidate.has_source_file:
                    return candidate, None  # THE ESTIMATE
        return period, gap

    monkeypatch.setattr(CT, "_resolve_period", substituting)

    result = CT.dispatch("get_facts",
                         {"metric": "total_assets", "period": "October 2024"},
                         ctx)
    # The plant produces a confident, well-formed, WRONG answer …
    assert result.ok, "the plant did not take — re-check it before trusting C5"
    # … and every C5 assertion the gate makes fails on it:
    assert result.values != ()          # would fail `values == ()`
    assert result.facts() != {}         # would fail `facts() == {}`
    said = " ".join([g.detail for g in result.gaps])
    assert "October 2024" not in said   # would fail the "names the month" check
    december = CT.dispatch("get_facts",
                           {"metric": "total_assets", "period": "December 2024"},
                           CT.CapsuleContext(entity_id=ctx.entity_id,
                                             periods=ctx.periods))
    assert (result.money_values()[0].amount_minor
            == december.money_values()[0].amount_minor), (
        "the plant should have answered with the neighbouring month")


def test_c5_no_refusal_offers_a_substitute_as_if_it_were_an_answer(ctx):
    """A refusal may OFFER another period ("Ask about one of: …"). It may
    never present that period's number. The line between the two is the
    whole gate: one is navigation, the other is a fabricated answer."""
    allowed = _identifier_tokens(ctx)
    for tool, _args, result in _results(ctx):
        for gap in result.gaps:
            assert figures_in(gap.fix, allowed) == [], (
                "%s gap %s offers a figure in its fix: %r"
                % (tool, gap.code, gap.fix))
            assert gap.to_payload().get("value") is None
            assert "amount_minor" not in gap.to_payload()


def test_c5_scenario_preview_states_its_scope_and_writes_nothing(ctx):
    """The one tool whose name sounds like a mutation. It is arithmetic
    over served facts and it says so — and it is registered read-only
    like everything else."""
    result = CT.dispatch("run_scenario_preview",
                         {"drivers": [{"metric": "revenue", "mode": "pct",
                                       "value": 10}],
                          "period": "p-dec"}, ctx)
    assert CT.TOOL_REGISTRY["run_scenario_preview"].read_only is True
    rules = [l.rule for l in result.limitations]
    assert CT.LIMIT_PREVIEW_SCOPE in rules, (
        "a preview that does not state its scope reads as a re-run")
    before = json.dumps(CT.dispatch("get_facts",
                                    {"metric": "revenue", "period": "p-dec"},
                                    ctx).to_payload())
    after = json.dumps(CT.dispatch("get_facts",
                                   {"metric": "revenue", "period": "p-dec"},
                                   ctx).to_payload())
    assert before == after, "a preview changed a served fact"


# ══════════════════════════════════════════════════════════════════════
# C6-E — the unit law, at the producer
# ══════════════════════════════════════════════════════════════════════


def test_c6_no_tool_accepts_a_display_currency(ctx):
    """The structural half: there is no dial here to turn. Display is a
    reader-side concern; a producer that took a currency argument could
    convert, and a converted operand is how the 1553% class of defect
    gets in."""
    for name in CT.TOOL_ALLOWLIST:
        spec = CT.TOOL_REGISTRY[name]
        for param in spec.params:
            assert "currency" not in param.name.lower(), (
                "%s takes a %s argument" % (name, param.name))
        result = CT.dispatch(name, {"currency": "EUR"}, ctx)
        assert not result.ok
        assert result.gaps[0].code == CT.GAP_BAD_ARGUMENTS
        assert "currency" in result.gaps[0].missing


def test_c6_ratios_are_invariant_across_a_currency_twin(pack, dec_period,
                                                        eur_twin):
    """THE GATE. The same books, declared in RON and in EUR. Ratios must
    be identical to the last bit; money must differ ONLY in its currency
    label, with identical minor units — because nothing here converts.

    PLANT (§C6-E): make ``_ratio_value`` divide the two operands after
    scaling the numerator by a rate. Emits
        RATIO MOVED WITH THE CURRENCY — current_ratio RON=2.8000000
        EUR=13.9020000
    """
    ron_ctx = CT.CapsuleContext(entity_id="org-1", periods=(dec_period,))
    eur_ctx = CT.CapsuleContext(entity_id="org-1", periods=(eur_twin,))

    for metric in ("current_ratio", "equity_ratio", "net_margin"):
        ron = CT.dispatch("get_facts", {"metric": metric}, ron_ctx)
        eur = CT.dispatch("get_facts", {"metric": metric}, eur_ctx)
        assert ron.ok and eur.ok, metric
        r, e = ron.values[0], eur.values[0]
        assert r.value == e.value, (
            "RATIO MOVED WITH THE CURRENCY — %s RON=%.7f EUR=%.7f"
            % (metric, r.value, e.value))
        assert r.numerator_minor == e.numerator_minor
        assert r.denominator_minor == e.denominator_minor
        assert r.unit == e.unit
        # The operand currency is RECORDED (auditable) but the ratio
        # itself is dimensionless.
        assert r.currency == "RON" and e.currency == "EUR"
        assert "currency" not in r.to_payload()

    for metric in ("total_assets", "revenue", "equity"):
        ron = CT.dispatch("get_facts", {"metric": metric}, ron_ctx)
        eur = CT.dispatch("get_facts", {"metric": metric}, eur_ctx)
        rm, em = ron.money_values()[0], eur.money_values()[0]
        assert rm.amount_minor == em.amount_minor, (
            "%s was converted at the producer" % metric)
        assert (rm.currency, em.currency) == ("RON", "EUR")


def test_c6_the_payload_differs_only_where_presentation_lives(pack, dec_period,
                                                              eur_twin):
    """Byte-level: serialize both twins, normalise the fields that are
    ALLOWED to differ (the currency label, the period identity), and
    require the rest to be identical. Anything else that moved is a
    conversion nobody declared."""
    ron = CT.dispatch("get_facts", {"metric": "total_assets"},
                      CT.CapsuleContext(entity_id="org-1",
                                        periods=(dec_period,))).to_payload()
    eur = CT.dispatch("get_facts", {"metric": "total_assets"},
                      CT.CapsuleContext(entity_id="org-1",
                                        periods=(eur_twin,))).to_payload()

    def normalise(payload: Dict[str, Any]) -> str:
        blob = json.dumps(payload, sort_keys=True)
        # Longest first — "p-dec-eur" must go before "p-dec".
        for token in ("p-dec-eur", "p-dec", "EUR", "RON"):
            blob = blob.replace(token, "<x>")
        return blob

    assert normalise(ron) == normalise(eur)


def test_c6_a_result_never_straddles_two_currencies(ctx, pack, dec_period,
                                                    eur_twin):
    """One result, one currency — enforced by the producer, so no reader
    ever has to notice. The cross-currency comparison is refused with a
    stated rule rather than performed at a rate nobody chose."""
    mixed = CT.CapsuleContext(entity_id="org-1", periods=(dec_period, eur_twin))
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets"], "p1": "p-dec-eur",
                          "p2": "p-dec"}, mixed)
    assert result.values == ()
    assert result.limitations[0].rule == CT.LIMIT_NATIVE_UNITS
    for _tool, _args, res in _results(ctx):
        res.to_payload()  # raises if two currencies ever met in one result


# ══════════════════════════════════════════════════════════════════════
# C9-E — retrieval latency, measured
# ══════════════════════════════════════════════════════════════════════

#: Retrieval is INSIDE the first-token budget (retrieval before
#: generation, always). The p50 target for first token is 1.5 s; a
#: retrieval ceiling of 250 ms per call leaves the model the rest. The
#: number this gate REPORTS is the measurement, not this ceiling.
RETRIEVAL_CEILING_MS = 250.0


def test_c9_retrieval_latency_is_measured_and_reported(ctx, capsys):
    """Runs the whole provocation matrix, twice (warm), and prints the
    distribution. Reported in design_review/capsule/GATES.md §C9."""
    samples = []  # type: List[Tuple[str, float]]
    for _ in range(2):
        for tool, args in PROVOCATIONS:
            t0 = time.perf_counter()
            CT.dispatch(tool, args, ctx)
            samples.append((tool, (time.perf_counter() - t0) * 1000.0))

    values = sorted(s for _tool, s in samples)
    p50 = statistics.median(values)
    p95 = values[max(0, int(round(0.95 * (len(values) - 1))))]
    worst_tool, worst = max(samples, key=lambda s: s[1])
    with capsys.disabled():
        print("\n[C9-E] capsule retrieval over %d dispatches: "
              "p50=%.2fms p95=%.2fms max=%.2fms (%s)"
              % (len(samples), p50, p95, worst, worst_tool))
    assert p95 < RETRIEVAL_CEILING_MS, (
        "retrieval p95 %.2fms exceeds the %.0fms budget — the first-token "
        "p50 cannot hold" % (p95, RETRIEVAL_CEILING_MS))


def test_c9_retrieval_is_deterministic_and_therefore_cacheable(ctx):
    """Latency work is only safe if the same question gives the same
    bytes; a cache in front of a nondeterministic producer is a
    correctness bug with a performance excuse."""
    for tool, args in PROVOCATIONS:
        first = json.dumps(CT.dispatch(tool, args, ctx).to_payload(),
                           sort_keys=True)
        second = json.dumps(CT.dispatch(tool, args, ctx).to_payload(),
                            sort_keys=True)
        assert first == second, "%s %r is not deterministic" % (tool, args)
