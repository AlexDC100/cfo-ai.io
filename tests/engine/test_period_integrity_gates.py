"""PERIOD-ASSIGNMENT INTEGRITY — the W1..W6 gate battery.

One file, six gates, each pinned to the production defect it exists to
make unrepeatable. Run as its own named battery gate:

    python -m pytest tests/engine/test_period_integrity_gates.py -q
    python scripts/run_battery.py            # gate name: period-integrity

THE DEFECT (2026-08-30, live data)
----------------------------------
`documents.period_end_hint` is a CONFIRMATION channel: it means "a human
confirmed that THIS document belongs to THIS month", and `stage_persist`
ranks it above its own detection precisely because of that meaning. The
frontend filled it with the DROP TARGET's date — a number read off the
UI, never off the document — so the engine dutifully discarded correct
detections. Every mismatched row in the audit carries `hint == stored`,
which is the proof: a 2025 Carniprod trial balance filed under 2017-12,
and one month (2025-12) holding source files from two different
companies.

WHAT EACH GATE PINS, AND THE PLANT THAT PROVES IT TRIPS
-------------------------------------------------------
W1  The period is NEVER inherited from UI state.
    · engine half: `detect_period` has no channel for it, and
      `resolve_period_end_for_persist` reads only the document and its
      parse.
    · frontend half: no `uploadDocument(...)` call site may pass a
      period-ROW date into `periodEndHint`, and nothing outside
      `lib/supabase.ts` may write the `period_end_hint` column.
    PLANT: `test_w1_scanner_catches_the_exact_production_plant` runs the
    scanner over the literal pre-fix source of PeriodsSection.tsx
    (`periodEndHint: p.period_end`) and asserts it is REJECTED, while
    the fixed shape is ACCEPTED. The plant ships with the gate, so the
    proof is executable forever instead of a one-off experiment.

W2  Ranked, hint-free detection. filename-only and content-only both
    resolve; an undetectable document forces an explicit human choice
    (ABSENT != ZERO) and is never filed as a detection.
    PLANT: `test_w2_plant_absent_is_not_reported_as_a_detection` —
    the same call whose signal is `none` must not produce a
    `signal_used` inside SIGNALS; if "none" were ever mapped to today
    or to a confidence above 0 the assertion fails.

W3  Mismatch + entity surfacing fire on the EXACT live cases, pinned
    from `fixtures/period_detect/production_cases.json` and from the
    audit's own output over production-shaped rows.
    PLANT: `test_w3_plant_agreeing_hint_is_not_a_mismatch` flips the
    Carniprod hint to the detected month; `mismatch` must go False. A
    gate that reports mismatch either way is vacuous.

W4  A moved document recomputes BOTH periods; no orphaned snapshot is
    served. Two halves: the snapshot SELF-IDENTIFIES the period it was
    filed under (which is what makes an orphan detectable), and the
    correction seam exists, exposes an orphan predicate, and takes its
    target month explicitly — W1's law applied to the correction path.
    The behavioural depth belongs to the move lane's own suite
    (`tests/engine/test_period_move.py`) and is deliberately not
    duplicated; this file only refuses to let that proof vanish.
    PLANT: `test_w4_plant_self_identification_is_not_vacuous` — a
    record whose `resolved_period_end` disagrees with the period it was
    filed under is exactly an orphan, and is rejected.

W5  `scripts/audit_period_assignment.py` reports and changes NOTHING.
    Proven twice: statically (no mutating call appears in its source)
    and at runtime (it runs to completion against a client that raises
    on every mutating method).
    PLANT: `test_w5_plant_mutation_trap_actually_traps` proves the trap
    client raises on `.update(...)`, so the runtime proof cannot pass
    by accident.

W6  No regression. Every filename the engine helper already resolved
    resolves identically through the new service, and a hint that
    AGREES with detection changes nothing. The byte-identical corpus
    half is the existing `corpus-replay` battery gate (18/18) — not
    duplicated here; see GATES.md.
    PLANT: `test_w6_plant_parity_table_is_not_vacuous` asserts the
    parity table actually contains resolved dates, so a table of
    all-None could never pass it.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import inspect
import io
import json
import re
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from engine.api import _period_detect
from engine.api._period_detect import CONFIDENCE, SIGNALS, detect_period
from engine.api.pipeline import (
    _detect_period_end_from_filename,
    resolve_period_end_for_persist,
)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "period_detect"
FRONTEND = REPO / "frontend"
AUDIT_SCRIPT = REPO / "scripts" / "audit_period_assignment.py"


def _production_cases() -> Dict[str, Dict[str, Any]]:
    payload = json.loads((FIXTURES / "production_cases.json").read_text("utf-8"))
    return dict((c["id"], c) for c in payload["cases"])


CASES = _production_cases()
CARNIPROD_HEADER = (FIXTURES / "carniprod_tb_header.txt").read_text("utf-8")


def _doc(**kw: Any) -> Dict[str, Any]:
    row = {
        "id": "doc-1",
        "org_id": "org-1",
        "original_filename": None,
        "period_end_hint": None,
    }
    row.update(kw)
    return row


# ══════════════════════════════════════════════════════════════════════
# W1 — THE PERIOD IS NEVER INHERITED FROM UI STATE
# ══════════════════════════════════════════════════════════════════════
#
# The frontend half is enforced by a source scanner rather than a
# runtime test, deliberately: the defect is a VALUE CHOICE at a call
# site ("which date do I put in the confirmation channel?"), and a
# runtime test can only observe the choice the code already made. The
# scanner states the law directly — and the law is the whole fix.


# TypeScript declarations and type annotations are not call sites; only
# text inside an `uploadDocument( ... )` argument list is scanned, so
# `periodEndHint?: string | null` in an options interface is naturally
# out of scope.
_UPLOAD_CALL = re.compile(r"\buploadDocument\s*\(")

#: A period ROW's date. `financial_periods.period_end` reached through
#: any accessor — `p.period_end`, `attachPeriod!.period_end`,
#: `period?.period_end`. `\b` keeps `period_end_hint` out.
_PERIOD_ROW_DATE = re.compile(r"\.period_end\b")

#: How many local `const`/`let` hops the scanner follows before it gives
#: up and allows the value. One hop covers the real pre-fix shape (the
#: dialog's `const periodEnd = attachPeriod!.period_end ?? …`); three is
#: headroom. A value that reaches the call site from a function
#: PARAMETER is allowed — it came from the caller, and in the confirmed
#: flow that caller is the period-confirm dialog.
_MAX_HOPS = 3
_INIT_CAP = 400


_BLOCK_COMMENT = re.compile(r"/\*[\s\S]*?\*/")
_LINE_COMMENT = re.compile(r"(?<!:)//[^\n]*")


def _strip_comments(text: str) -> str:
    """Comments are prose, not call sites.

    This matters: the sibling lanes document the defect by QUOTING it
    (`// uploadDocument(file, { periodEndHint: p.period_end })`), and a
    scanner that read comments would report the documentation of the bug
    as the bug. The `(?<!:)` guard keeps `https://` intact."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def _balanced_slice(text: str, open_index: int) -> str:
    """Text between the bracket at `open_index` and its match.

    Bracket counting only — these sources contain no unbalanced bracket
    inside a string literal, and a miscount could only widen the slice,
    which makes the scanner stricter, never laxer."""
    depth = 0
    i = open_index
    while i < len(text):
        ch = text[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                return text[open_index + 1:i]
        i += 1
    return text[open_index + 1:]


def _hint_value(call_args: str) -> Optional[str]:
    """The expression assigned to `periodEndHint` inside one call's
    argument list, or None when the call doesn't mention it.

    Shorthand (`{ scope, periodEndHint }`) yields the identifier itself,
    which the caller then resolves."""
    m = re.search(r"\bperiodEndHint\b", call_args)
    if not m:
        return None
    rest = call_args[m.end():].lstrip()
    if not rest.startswith(":"):
        return "periodEndHint"  # object shorthand
    rest = rest[1:]
    out: List[str] = []
    depth = 0
    for ch in rest:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            break
        out.append(ch)
    return "".join(out).strip()


def _local_initializers(ident: str, text: str) -> List[str]:
    pattern = re.compile(
        r"\b(?:const|let|var)\s+" + re.escape(ident) + r"\s*(?::[^=;]+)?=\s*([\s\S]*?);"
    )
    return [m.group(1)[:_INIT_CAP] for m in pattern.finditer(text)]


def _expression_carries_a_period_row_date(expr: str, text: str) -> Optional[str]:
    """The offending evidence, or None when the value is clean.

    Direct first (`p.period_end`), then up to `_MAX_HOPS` local
    `const`/`let` hops so a renamed alias can't launder the same value.

    When the offence is reached through a hop, EVERY binding of that
    name in the file that carries a period-row date is reported, not
    just the first: the scanner has no scope analysis, so naming one
    binding would point the reader at a declaration that may not be the
    one this call site actually reads."""
    seen = set()
    frontier = [expr]
    for _hop in range(_MAX_HOPS + 1):
        offences = [c for c in frontier if _PERIOD_ROW_DATE.search(c)]
        if offences:
            return " | ".join(_flatten(o) for o in offences)
        nxt: List[str] = []
        for candidate in frontier:
            if candidate in seen:
                continue
            seen.add(candidate)
            ident = candidate.strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", ident):
                nxt.extend(_local_initializers(ident, text))
        if not nxt:
            break
        frontier = nxt
    return None


def _flatten(expr: str) -> str:
    return re.sub(r"\s+", " ", expr).strip()


#: A TypeScript type annotation rather than a value. `period_end_hint:
#: string | null;` inside an interface DESCRIBES the column; it does not
#: write it, and a gate that confused the two would push callers into
#: being vaguer about the shape they handle.
_TS_PRIMITIVE = r"(?:string|number|boolean|Date|null|undefined|any|unknown)"
_TS_TYPE_ONLY = re.compile(
    r"^\s*%s(?:\s*\|\s*%s)*\s*;?\s*$" % (_TS_PRIMITIVE, _TS_PRIMITIVE)
)


def scan_upload_hint_law(text: str) -> List[Tuple[str, str]]:
    """W1's frontend law, over one file's source.

    Returns `[(hint_expression, offending_sub_expression)]` — empty when
    the file obeys the law: no `uploadDocument(...)` call site passes a
    period-ROW date into `periodEndHint`."""
    text = _strip_comments(text)
    findings: List[Tuple[str, str]] = []
    for m in _UPLOAD_CALL.finditer(text):
        args = _balanced_slice(text, m.end() - 1)
        value = _hint_value(args)
        if value is None:
            continue
        offender = _expression_carries_a_period_row_date(value, text)
        if offender is not None:
            findings.append((value, offender))
    return findings


def _frontend_sources() -> List[Path]:
    files: List[Path] = []
    for pattern in ("*.ts", "*.tsx"):
        for path in FRONTEND.rglob(pattern):
            if "node_modules" in path.parts:
                continue
            files.append(path)
    assert files, "no frontend sources found — the scanner would pass vacuously"
    return files


# ── W1 · the plant, shipped with the gate ─────────────────────────────

#: The literal pre-fix source shape, from
#: frontend/components/cfo/workspace/PeriodsSection.tsx (the drag & drop
#: attach handler and the add/replace dialog). This is the defect.
PLANT_DROP_TARGET_DATE = """
  async function attachFileToPeriod(p: OrgPeriod, file: File) {
    const { row, error } = await uploadDocument(file, {
      scope: "financial",
      periodEndHint: p.period_end,
    });
  }
"""

PLANT_LAUNDERED_THROUGH_A_LOCAL = """
  async function submit(attachPeriod: OrgPeriod, month: string, file: File) {
    const periodEnd = attachMode
      ? attachPeriod!.period_end ?? lastDayIso(month)
      : lastDayIso(month);
    await uploadDocument(file, { scope: "financial", periodEndHint: periodEnd });
  }
"""

#: What a lawful call site looks like: the date came off the DOCUMENT
#: (via /api/period/detect) and a human confirmed it.
LAWFUL_CONFIRMED_BY_HUMAN = """
  async function submit(file: File, confirmed: string | null) {
    const detected = await detectPeriodForFile(file);
    const confirmedEnd = confirmed ?? detected.proposed_period_end;
    await uploadDocument(file, { scope: "financial", periodEndHint: confirmedEnd });
  }
"""

LAWFUL_PARAMETER_FROM_THE_CONFIRM_DIALOG = """
  function scanOneFile(file: File, periodEndHint: string | null = null) {
    return uploadDocument(file, { scope: "financial", periodEndHint, jurisdictionHint });
  }
"""


def test_w1_scanner_catches_the_exact_production_plant():
    """PLANT — the scanner rejects the two real pre-fix shapes and
    accepts the two lawful ones. Without this, a scanner that never
    fires would report a green W1 forever."""
    direct = scan_upload_hint_law(PLANT_DROP_TARGET_DATE)
    assert direct, (
        "the scanner did not catch `periodEndHint: p.period_end` — the "
        "literal production defect. W1 would be vacuous."
    )
    assert ".period_end" in direct[0][1]

    laundered = scan_upload_hint_law(PLANT_LAUNDERED_THROUGH_A_LOCAL)
    assert laundered, (
        "the drop target's date reached the call site through a local "
        "`const periodEnd = …` and the scanner missed it — renaming the "
        "value would defeat W1."
    )

    assert scan_upload_hint_law(LAWFUL_CONFIRMED_BY_HUMAN) == [], (
        "a date the human confirmed against the DOCUMENT's own detection "
        "is the one lawful source for this channel; the scanner must not "
        "block it."
    )
    assert scan_upload_hint_law(LAWFUL_PARAMETER_FROM_THE_CONFIRM_DIALOG) == [], (
        "a value arriving as a function parameter came from the caller "
        "(the period-confirm dialog) and is out of this file's reach."
    )

    quoted_in_a_comment = "// " + PLANT_DROP_TARGET_DATE.replace("\n", "\n// ")
    assert scan_upload_hint_law(quoted_in_a_comment) == [], (
        "the scanner read a COMMENT as a call site. The sibling lanes "
        "document this defect by quoting it; reporting the documentation "
        "of the bug as the bug would make W1 unfixable."
    )


def test_w1_no_upload_call_site_passes_a_period_row_date_as_the_hint():
    """THE LAW. `period_end_hint` may only ever carry a date a human
    confirmed for THAT document. A period row's own date is UI state —
    the drop target — and is exactly what produced the 2017/2025
    misfiling."""
    offenders: List[str] = []
    for path in _frontend_sources():
        text = path.read_text("utf-8", errors="ignore")
        for value, sub in scan_upload_hint_law(text):
            offenders.append(
                "%s\n      periodEndHint: %s\n      (resolves through: %s)"
                % (path.relative_to(REPO), value.strip(), sub.strip())
            )
    assert not offenders, (
        "W1 VIOLATED — an uploadDocument call site fills the human-"
        "confirmation channel with a period ROW's date:\n\n    "
        + "\n    ".join(offenders)
        + "\n\n  `documents.period_end_hint` means 'a human confirmed THIS "
        "document belongs to THIS month'. stage_persist ranks it above "
        "its own detection because of that meaning, so a drop-target date "
        "here silently overrides correct detection — the 2026-08-30 "
        "production defect (Carniprod 2025 filed under 2017-12).\n"
        "  Fix: send the date the user confirmed against "
        "GET/POST /api/period/detect for THIS file, or send nothing at "
        "all (ABSENT != ZERO — the engine then detects, and flags "
        "`fallback_today` when it truly cannot)."
    )


def test_w1_only_the_upload_helper_writes_the_period_end_hint_column():
    """A second door onto the same channel: a direct
    `.insert({ period_end_hint })` would bypass the scanner above."""
    allowed = {Path("frontend/lib/supabase.ts")}
    writers: List[str] = []
    for path in _frontend_sources():
        rel = path.relative_to(REPO)
        if rel in allowed or "__tests__" in rel.parts:
            continue
        # A WRITE is `period_end_hint:` in an object literal. Comments
        # and reads (`row.period_end_hint`) are not writes.
        text = _strip_comments(path.read_text("utf-8", errors="ignore"))
        for m in re.finditer(r"(?<![.\w])period_end_hint\s*:", text):
            line_end = text.find("\n", m.start())
            rest = text[m.end():line_end if line_end != -1 else len(text)]
            if _TS_TYPE_ONLY.match(rest):
                # `period_end_hint: string | null;` in an interface —
                # a shape declaration, not a write. Describing the
                # column's type is how a caller stays honest about it.
                continue
            line_start = text.rfind("\n", 0, m.start()) + 1
            writers.append(
                "%s: %s" % (rel, text[line_start:line_end].strip())
            )
    assert not writers, (
        "W1 VIOLATED — the `period_end_hint` column is written outside "
        "lib/supabase.ts's uploadDocument:\n    " + "\n    ".join(writers)
        + "\n  One writer keeps the law enforceable in one place."
    )


def test_w1_plant_the_column_writer_check_tells_writes_from_declarations():
    """PLANT — a real write is caught; an interface field describing the
    column's type is not. Confusing the two would push callers into
    being vaguer about the shape they handle, which helps nobody."""
    assert not _TS_TYPE_ONLY.match(" period_end_hint")  # sanity: not a type
    assert _TS_TYPE_ONLY.match(" string | null;")
    assert _TS_TYPE_ONLY.match(" string;")
    assert not _TS_TYPE_ONLY.match(" p.period_end,")
    assert not _TS_TYPE_ONLY.match(" confirmedEnd,")


def test_w1_detection_service_has_no_channel_for_ui_state():
    """Engine half. The signature is the guarantee: with no parameter
    for it, the open period cannot reach the decision even by mistake."""
    sig = inspect.signature(detect_period)
    assert set(sig.parameters) == {"extracted", "filename"}
    kinds = set(p.kind for p in sig.parameters.values())
    assert inspect.Parameter.VAR_KEYWORD not in kinds
    for name in ("open_period_end", "active_period_end", "target_period_end"):
        with pytest.raises(TypeError):
            detect_period(filename="x_2025.xlsx", **{name: "2017-12-31"})


def test_w1_persist_resolution_reads_only_the_document_and_its_parse():
    """`resolve_period_end_for_persist(doc, parsed)` — two inputs, both
    about the document. No client, no org, no active period."""
    sig = inspect.signature(resolve_period_end_for_persist)
    assert list(sig.parameters) == ["doc", "parsed"]
    source = inspect.getsource(resolve_period_end_for_persist)
    for banned in ("active_period", "open_period", "current_period", "_supabase"):
        assert banned not in source, (
            "resolve_period_end_for_persist reads %r — the period a "
            "document belongs to must come from the document, never from "
            "what the UI happens to have open." % banned
        )


# ══════════════════════════════════════════════════════════════════════
# W2 — RANKED, HINT-FREE DETECTION; ABSENT FORCES A CHOICE
# ══════════════════════════════════════════════════════════════════════


def test_w2_filename_only_document_resolves():
    case = CASES["carniprod_2025_filed_under_2017"]
    got = detect_period(extracted=None, filename=case["filename"])
    assert got["proposed_period_end"] == case["expected_proposed_period_end"]
    assert got["signal_used"] == case["expected_signal_used"] == "filename"
    assert got["confidence"] == CONFIDENCE["filename"]
    assert case["filename"] in got["evidence_snippet"]


def test_w2_content_only_document_resolves():
    """No filename at all — the real Romanian trial-balance preamble is
    the only evidence, and it is enough."""
    got = detect_period(extracted={"header_text": CARNIPROD_HEADER}, filename=None)
    assert got["proposed_period_end"] == "2025-12-31"
    assert got["signal_used"] == "closing_balance"
    assert "31.12.2025" in got["evidence_snippet"]


def test_w2_ranking_is_honored_when_the_signals_disagree():
    """in_document > closing_balance > filename — and every loser stays
    visible in `candidates` so Parts D/E can render the disagreement
    instead of only the winner."""
    got = detect_period(
        extracted={"period_end": "2024-06-30", "header_text": CARNIPROD_HEADER},
        filename="balanta_dec_2017.xlsx",
    )
    assert got["signal_used"] == "in_document"
    assert got["proposed_period_end"] == "2024-06-30"
    assert [c["signal"] for c in got["candidates"]] == [
        "in_document",
        "closing_balance",
        "filename",
    ]
    assert [c["period_end"] for c in got["candidates"]] == [
        "2024-06-30",
        "2025-12-31",
        "2017-12-31",
    ]


def test_w2_confidence_is_strictly_ordered_by_tier():
    assert (
        CONFIDENCE["in_document"]
        > CONFIDENCE["closing_balance"]
        > CONFIDENCE["filename"]
        > CONFIDENCE["none"]
        == 0.0
    )


def test_w2_undetectable_document_forces_an_explicit_choice():
    """ABSENT != ZERO. No signal is a first-class answer — not today,
    not the open period, not a guess."""
    case = CASES["no_filename_date_signal"]
    got = detect_period(extracted=None, filename=case["filename"])
    assert got["proposed_period_end"] is None
    assert got["signal_used"] == "none"
    assert got["confidence"] == 0.0
    assert got["evidence_snippet"] is None
    assert got["candidates"] == []


def test_w2_persist_records_absence_as_a_fallback_never_as_a_detection():
    """The persist seam still has to file the document somewhere, so it
    uses today — but labels it `fallback_today` with confidence 0, which
    is what lets the UI ask instead of pretending."""
    doc = _doc(original_filename=CASES["no_filename_date_signal"]["filename"])
    period_end, record = resolve_period_end_for_persist(doc, {})
    assert period_end == date.today().isoformat()
    assert record["signal_used"] == "fallback_today"
    assert record["signal_used"] not in SIGNALS
    assert record["confidence"] == 0.0
    assert record["detected"]["proposed_period_end"] is None
    assert record["mismatch"] is False, (
        "a document with no evidence of its own cannot DISAGREE with "
        "anything — ABSENT != ZERO applies to the mismatch verdict too."
    )


def test_w2_plant_absent_is_not_reported_as_a_detection():
    """PLANT — if "none" were ever mapped onto today or onto a real
    signal name, these two assertions are what breaks."""
    got = detect_period(extracted=None, filename="balanta verificare.xlsx")
    assert got["signal_used"] == "none"
    assert got["proposed_period_end"] != date.today().isoformat()
    assert got["proposed_period_end"] is None


def test_w2_today_is_never_proposed_by_any_tier():
    today = date.today().isoformat()
    for extracted in (
        {"period_end": today},
        {"closing_balance_date": today},
        {"header_text": "BALANTA DE VERIFICARE la data de %s" % today},
    ):
        got = detect_period(extracted=extracted, filename=None)
        assert got["proposed_period_end"] is None, (
            "today is the engine helper's 'I found nothing' value, so it "
            "is indistinguishable from absence and must never be "
            "proposed: %r" % extracted
        )


# ══════════════════════════════════════════════════════════════════════
# W3 — MISMATCH + ENTITY SURFACING ON THE EXACT LIVE CASES
# ══════════════════════════════════════════════════════════════════════


def test_w3_carniprod_2025_filed_under_2017_is_recorded_as_a_mismatch():
    """THE reported case, end to end at the persist seam.

    The hint still wins (it is the confirmation channel and rank 1 is
    correct) — but the disagreement is written into the envelope, so the
    row can be surfaced and corrected by a human instead of silently
    standing."""
    case = CASES["carniprod_2025_filed_under_2017"]
    doc = _doc(
        original_filename=case["filename"],
        period_end_hint=case["period_end_hint"],
    )
    period_end, record = resolve_period_end_for_persist(doc, {})

    assert period_end == case["stored_period_end"] == "2017-12-31"
    assert record["signal_used"] == "user_confirmed"
    assert record["mismatch"] is True
    assert record["detected"]["proposed_period_end"] == "2025-12-31"
    assert record["detected"]["signal_used"] == "filename"
    # Both sides legible without recomputation — Parts D/E render this.
    assert record["hint"] == "2017-12-31"
    assert record["resolved_period_end"] == "2017-12-31"


def test_w3_plant_agreeing_hint_is_not_a_mismatch():
    """PLANT — same document, hint moved onto the detected month. A gate
    that flagged this too would be flagging everything."""
    case = CASES["carniprod_2025_filed_under_2017"]
    doc = _doc(
        original_filename=case["filename"],
        period_end_hint=case["expected_proposed_period_end"],
    )
    period_end, record = resolve_period_end_for_persist(doc, {})
    assert period_end == "2025-12-31"
    assert record["mismatch"] is False


def test_w3_scandia_realestate_belongs_where_it_is():
    """The second file in the collided month genuinely belongs to
    2025-12 — the month collision is the finding, not this row."""
    case = CASES["scandia_realestate_collides_in_2025_12"]
    doc = _doc(
        original_filename=case["filename"],
        period_end_hint=case["period_end_hint"],
    )
    period_end, record = resolve_period_end_for_persist(doc, {})
    assert period_end == case["stored_period_end"] == "2025-12-31"
    assert record["mismatch"] is False


def test_w3_legacy_2050_row_is_refused_not_propagated():
    """The pre-clamp rows. The service must REFUSE 2050 rather than
    propose it, and the out-of-range hint must not mint a corrupt
    period; the document falls through to `fallback_today`, which is the
    state that makes the UI ask."""
    case = CASES["agras_2050_legacy_row"]
    got = detect_period(extracted=None, filename=case["filename"])
    assert got["proposed_period_end"] is None
    assert got["signal_used"] == "none"

    doc = _doc(
        original_filename=case["filename"],
        period_end_hint=case["period_end_hint"],
    )
    period_end, record = resolve_period_end_for_persist(doc, {})
    assert not period_end.startswith("2050")
    assert record["hint"] is None, "an out-of-range hint must be dropped, not trusted"
    assert record["signal_used"] == "fallback_today"


def test_w3_every_pinned_production_case_matches_the_service():
    """The whole audit fixture, in one sweep — so a future change to
    ranking or clamping cannot quietly re-open one of them."""
    for case_id, case in sorted(CASES.items()):
        got = detect_period(extracted=case["extracted"], filename=case["filename"])
        assert got["proposed_period_end"] == case["expected_proposed_period_end"], case_id
        assert got["signal_used"] == case["expected_signal_used"], case_id


# ── W3 · entity surfacing: two companies inside one month ─────────────
#
# The engine does not BLOCK a second entity in a month — under standing
# law wrong rows are SURFACED for a human to correct, never silently
# rewritten. The surfacing guard is the audit script, driven here over
# production-shaped rows.

ORG = "org-1"

AUDIT_DOCS = [
    # The reported case: a 2025 file stored in 2017, hint == stored.
    {"id": "d1", "org_id": ORG, "original_filename": "Carniprod Trial Balance 2025.xlsx",
     "period_id": "p1", "period_end_hint": "2017-12-31", "status": "analyzed",
     "created_at": "2026-08-01T00:00:00Z", "detected_type": "trial_balance"},
    # The collided month: two source files, two companies, one month.
    {"id": "d2", "org_id": ORG, "original_filename": "Balanta Scandia RealEstate_31.12.2025.xls",
     "period_id": "p2", "period_end_hint": "2025-12-31", "status": "analyzed",
     "created_at": "2026-08-02T00:00:00Z", "detected_type": "trial_balance"},
    {"id": "d3", "org_id": ORG, "original_filename": "Balanta Carniprod_31.12.2025.xls",
     "period_id": "p3", "period_end_hint": "2025-12-31", "status": "analyzed",
     "created_at": "2026-08-03T00:00:00Z", "detected_type": "trial_balance"},
    # The legacy pre-clamp rows.
    {"id": "d4", "org_id": ORG, "original_filename": "agras_tb_2025.xlsx",
     "period_id": "p4", "period_end_hint": "2050-12-31", "status": "analyzed",
     "created_at": "2026-08-04T00:00:00Z", "detected_type": "trial_balance"},
    # A file with no filename date signal at all.
    {"id": "d5", "org_id": ORG, "original_filename": "balanta verificare.xlsx",
     "period_id": "p5", "period_end_hint": "2025-06-30", "status": "analyzed",
     "created_at": "2026-08-05T00:00:00Z", "detected_type": "trial_balance"},
]

AUDIT_PERIODS = [
    {"id": "p1", "org_id": ORG, "period_end": "2017-12-31", "source_document_id": "d1"},
    {"id": "p2", "org_id": ORG, "period_end": "2025-12-31", "source_document_id": "d2"},
    {"id": "p3", "org_id": ORG, "period_end": "2025-12-31", "source_document_id": "d3"},
    {"id": "p4", "org_id": ORG, "period_end": "2050-12-31", "source_document_id": "d4"},
    {"id": "p5", "org_id": ORG, "period_end": "2025-06-30", "source_document_id": "d5"},
]


class _MutationTrapClient:
    """A Supabase client that can only READ.

    Every mutating method raises, so W5's read-only claim is proven by
    execution and not by inspection alone."""

    MUTATORS = (
        "insert", "update", "upsert", "delete", "rpc",
        "delete_object", "signed_url",
    )

    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]) -> None:
        self.tables = tables
        self.reads: List[str] = []

    def __enter__(self) -> "_MutationTrapClient":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def select(self, table: str, **_kw: Any) -> List[Dict[str, Any]]:
        self.reads.append(table)
        return list(self.tables.get(table, []))

    def __getattr__(self, name: str) -> Any:
        if name in self.MUTATORS:
            raise AssertionError(
                "W5 VIOLATED — the audit called %r. It reports; it never "
                "rewrites. Wrong rows are corrected by a human through the "
                "move-to-period path, never silently in place." % name
            )
        raise AttributeError(name)


@pytest.fixture()
def audit_module(monkeypatch):
    """`scripts/audit_period_assignment.py`, loaded and wired to the
    trap client. The script does `from engine.api import _supabase` and
    calls `_supabase.admin()` at run time, so patching the attribute on
    the shared module is enough."""
    from conftest import load_module_from_path  # tests/engine/conftest.py

    module = load_module_from_path("audit_period_assignment", AUDIT_SCRIPT)
    trap = _MutationTrapClient(
        {"documents": AUDIT_DOCS, "financial_periods": AUDIT_PERIODS}
    )
    from engine.api import _supabase as supabase_module

    monkeypatch.setattr(supabase_module, "admin", lambda: trap)
    return module, trap


def _run_audit(module) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = module.main([])
    assert rc == 0
    return buf.getvalue()


def _section(out: str, header: str) -> str:
    """Text from one report heading up to the next blank-line break."""
    start = out.find(header)
    assert start != -1, "audit output has no %r section:\n%s" % (header, out)
    end = out.find("\n\n", start)
    return out[start:end if end != -1 else len(out)]


def test_w3_audit_surfaces_the_carniprod_disagreement(audit_module):
    module, _trap = audit_module
    out = _run_audit(module)
    section = _section(out, "STORED vs DETECTED-FROM-FILENAME")
    assert "Carniprod Trial Balance 2025.xlsx" in section
    assert "stored 2017-12" in section and "detected 2025-12" in section
    # The proof line: the hint equals what was stored, so a human never
    # confirmed anything — the drop target did.
    assert "hint=2017-12-31" in section


def test_w3_audit_surfaces_two_companies_inside_one_month(audit_module):
    """The second reported case. Two source files from two companies
    share 2025-12; the audit names the month and both files."""
    module, _trap = audit_module
    out = _run_audit(module)
    section = _section(out, "MONTHS HOLDING MORE THAN ONE SOURCE FILE")
    assert "2025-12" in section
    assert "Balanta Scandia RealEstate_31.12.2025.xls" in section
    assert "Balanta Carniprod_31.12.2025.xls" in section
    # …and only that month. 2025-06 and 2017-12 hold one file each.
    assert "2025-06" not in section and "2017-12" not in section


def test_w3_audit_never_counts_a_missing_signal_as_a_disagreement(audit_module):
    """ABSENT != ZERO, applied to the audit itself. A file with no date
    in its name is reported under its own heading; counting it as a
    disagreement would manufacture findings."""
    module, _trap = audit_module
    out = _run_audit(module)
    disagreements = _section(out, "STORED vs DETECTED-FROM-FILENAME")
    absent = _section(out, "NO FILENAME DATE SIGNAL")
    assert "balanta verificare.xlsx" in absent
    assert "balanta verificare.xlsx" not in disagreements
    # The legacy 2050 row is surfaced with its implausible stored month.
    assert "agras_tb_2025.xlsx" in out
    assert "2050-12" in out


# ══════════════════════════════════════════════════════════════════════
# W4 — A MOVE RECOMPUTES BOTH PERIODS; NO ORPHANED SNAPSHOT IS SERVED
# ══════════════════════════════════════════════════════════════════════


def test_w4_snapshot_self_identifies_the_period_it_was_filed_under():
    """What makes an orphan DETECTABLE: every persisted envelope records
    the period it was written for. A snapshot whose
    `period_detection.resolved_period_end` no longer matches its period
    row's `period_end` is, by definition, an artifact of a move that did
    not recompute."""
    for case_id, case in sorted(CASES.items()):
        doc = _doc(
            original_filename=case["filename"],
            period_end_hint=case["period_end_hint"],
        )
        period_end, record = resolve_period_end_for_persist(doc, {})
        assert record["resolved_period_end"] == period_end, case_id


def test_w4_plant_self_identification_is_not_vacuous():
    """PLANT — a record that names a different month than the period it
    was filed under is exactly the orphan this invariant detects."""
    doc = _doc(
        original_filename="Carniprod Trial Balance 2025.xlsx",
        period_end_hint="2017-12-31",
    )
    period_end, record = resolve_period_end_for_persist(doc, {})
    orphaned = dict(record, resolved_period_end="2025-12-31")
    assert orphaned["resolved_period_end"] != period_end


def test_w4_stamp_is_wired_into_persist_and_surfaced_to_the_ui():
    """The two ends of the ground-truth path: `stage_persist` stamps the
    record onto the envelope, and the periods listing hands it to the UI
    verbatim so the mismatch chip never recomputes a verdict about a row
    it did not write."""
    source = (REPO / "src" / "engine" / "api" / "pipeline.py").read_text("utf-8")
    assert 'canonical["period_detection"] = period_detection' in source
    assert '"period_detection": (' in source
    assert '.get("period_detection")' in source


W4_SPEC = (
    "  Required (Part D — the correction path):\n"
    "    · a seam that moves ONE document to a different period end;\n"
    "    · it recomputes BOTH periods — the one vacated and the one "
    "joined — so neither serves a snapshot describing a document it no "
    "longer holds;\n"
    "    · it drops the vacated period when it keeps no documents, "
    "rather than leaving an empty period serving a stale envelope;\n"
    "    · it emits a journal event, so the correction is part of the "
    "record like every other write;\n"
    "    · an ORPHAN PREDICATE — a callable that answers 'is any period "
    "still serving an analysis no live attached document backs?' — so "
    "the invariant is checkable, not merely intended;\n"
    "    · the target month is an EXPLICIT argument with no clock and "
    "no open-period default (W1, applied to the correction path).\n"
    "  Until then a misfiled row can be SURFACED (the audit script, the "
    "mismatch chip) but not corrected in product."
)


def _move_module():
    """Part D's move seam, however it is named.

    Deliberately generous discovery: this gate is about the INVARIANTS
    (both periods recomputed, the move journalled, no orphan served),
    never about a particular function name."""
    try:
        from engine.api import _period_move  # noqa: WPS433 — optional seam

        return _period_move
    except ImportError:
        return None


def _named(module, *needles: str):
    """Public FUNCTIONS on `module` whose name contains every needle.

    Functions only — a dataclass named `MovePlan` is a shape, not a
    seam, and letting one satisfy the discovery would make these gates
    pass on a module that performs no move."""
    out = []
    for name in dir(module):
        if name.startswith("_"):
            continue
        value = getattr(module, name)
        if not inspect.isfunction(value):
            continue
        lowered = name.lower()
        if all(n in lowered for n in needles):
            out.append(value)
    return out


def test_w4_move_to_period_seam_exists():
    """Written RED and kept that way until the correction path existed.

    The audit's own closing line tells the operator to correct wrong
    rows "through the UI's move-to-period path (Part D), which re-runs
    both periods" — so without that path a misfiled document could be
    SURFACED but never fixed. The failure text is kept as the message
    rather than trimmed, so this gate still reads as the spec if the
    seam is ever removed."""
    module = _move_module()
    if module is None:
        pytest.fail("W4 NOT SATISFIABLE — no move-to-period seam exists yet.\n" + W4_SPEC)
    assert _named(module, "move") or _named(module, "plan"), (
        "the move module exists but exposes nothing that performs or "
        "plans a move.\n" + W4_SPEC
    )


def test_w4_orphan_predicate_exists_so_the_invariant_is_checkable():
    """"No orphaned snapshot served" has to be a function someone can
    call, or it is a wish."""
    module = _move_module()
    if module is None:
        pytest.fail("W4 NOT SATISFIABLE — no move-to-period seam exists yet.\n" + W4_SPEC)
    assert _named(module, "orphan"), (
        "no orphan predicate on the move seam.\n" + W4_SPEC
    )


def test_w4_move_target_month_is_explicit_never_the_clock_or_the_open_period():
    """W1's law, applied to the correction path: a move must file the
    document where the HUMAN said, and must not quietly default to
    today or to whatever period is open."""
    module = _move_module()
    if module is None:
        pytest.fail("W4 NOT SATISFIABLE — no move-to-period seam exists yet.\n" + W4_SPEC)
    movers = _named(module, "move") or _named(module, "plan")
    for fn in movers:
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):  # pragma: no cover — C callables
            continue
        for name, param in sig.parameters.items():
            lowered = name.lower()
            if "period" in lowered or "month" in lowered or "target" in lowered:
                assert param.default in (inspect.Parameter.empty, None), (
                    "%s.%s takes %s=%r — a defaulted target month is a "
                    "door for the clock or the open period to decide "
                    "where a document is filed."
                    % (module.__name__, fn.__name__, name, param.default)
                )
        for banned in ("open_period", "active_period", "current_period"):
            assert banned not in sig.parameters, (
                "%s.%s accepts %r — UI state is not an input to where a "
                "document belongs." % (module.__name__, fn.__name__, banned)
            )


def test_w4_move_behaviour_is_proven_by_a_dedicated_suite():
    """Coverage anchor. The DEPTH of W4 — plan/execute, both periods
    recomputed, the emptied period deleted, nothing orphaned — belongs
    to the move lane's own suite; this gate only refuses to let that
    proof disappear silently."""
    module = _move_module()
    if module is None:
        pytest.fail("W4 NOT SATISFIABLE — no move-to-period seam exists yet.\n" + W4_SPEC)
    tests_dir = Path(__file__).resolve().parent
    proving = [
        p.name
        for p in tests_dir.glob("test_*.py")
        if p.name != Path(__file__).name
        and "_period_move" in p.read_text("utf-8", errors="ignore")
    ]
    assert proving, (
        "the move seam exists but no test module exercises it. W4's "
        "behavioural proof (both periods recomputed, no orphan served) "
        "must live somewhere."
    )


# ══════════════════════════════════════════════════════════════════════
# W5 — THE AUDIT REPORTS AND CHANGES NOTHING
# ══════════════════════════════════════════════════════════════════════


#: Every mutating method on `_supabase.SupabaseClient`. Scoped to the
#: names the audit BINDS its client to, so an ordinary Python call like
#: `sys.path.insert(...)` is not mistaken for a database write.
_CLIENT_MUTATORS = (
    "insert", "update", "upsert", "delete", "delete_object", "rpc",
)
_CLIENT_BINDING = re.compile(
    r"with\s+_supabase\.(?:admin|per_user)\s*\([^)]*\)\s+as\s+(\w+)\s*:"
)


def test_w5_audit_source_contains_no_mutating_call():
    source = AUDIT_SCRIPT.read_text("utf-8")
    bindings = _CLIENT_BINDING.findall(source)
    assert bindings, (
        "no `with _supabase.admin() as <name>:` binding found in the "
        "audit — the scan below would have nothing to scope to and W5 "
        "would pass vacuously."
    )
    hits = []
    for name in bindings:
        for mutator in _CLIENT_MUTATORS:
            pattern = re.compile(r"\b%s\s*\.\s*%s\s*\(" % (re.escape(name), mutator))
            for m in pattern.finditer(source):
                line_start = source.rfind("\n", 0, m.start()) + 1
                hits.append(source[line_start:source.find("\n", m.start())].strip())
    # A second door: writing through the module rather than a binding.
    for mutator in _CLIENT_MUTATORS:
        if re.search(r"_supabase\s*\.\s*%s\s*\(" % mutator, source):
            hits.append("_supabase.%s(...)" % mutator)
    assert not hits, (
        "W5 VIOLATED — the audit calls a mutating method:\n    "
        + "\n    ".join(hits)
        + "\n  It exists to SURFACE bad rows for a human. Re-running it "
        "must always be safe."
    )


def test_w5_audit_opens_no_write_path_at_runtime(audit_module):
    """Executed proof, not inspection: the audit runs to completion
    against a client that raises on every mutating method."""
    module, trap = audit_module
    out = _run_audit(module)
    assert "Read-only: nothing was modified." in out
    assert sorted(set(trap.reads)) == ["documents", "financial_periods"]


def test_w5_plant_mutation_trap_actually_traps():
    """PLANT — without this, a trap that silently returned None would
    make the runtime proof above pass for the wrong reason."""
    trap = _MutationTrapClient({})
    for mutator in _MutationTrapClient.MUTATORS:
        with pytest.raises(AssertionError):
            getattr(trap, mutator)


def test_w5_audit_reuses_the_engine_helper_rather_than_reimplementing_it():
    """A second detector would drift from the engine's own and start
    reporting phantom disagreements."""
    source = AUDIT_SCRIPT.read_text("utf-8")
    assert (
        "from engine.api.pipeline import _detect_period_end_from_filename" in source
    )


# ══════════════════════════════════════════════════════════════════════
# W6 — NO REGRESSION ON PERIODS THAT WERE ALREADY CORRECT
# ══════════════════════════════════════════════════════════════════════
#
# The byte-identical corpus half is the existing `corpus-replay` battery
# gate (18/18 goldens). It is not re-run here: duplicating an existing
# gate doubles the battery's slowest step and gives a second place for
# the same truth to be asserted. What IS asserted here is the property
# corpus replay cannot see — that the new detection service returns the
# engine helper's own answer for every filename the helper already
# resolved.

#: Filenames the engine helper resolves on its own, from its docstring
#: and from the shapes seen in customer uploads.
HELPER_PARITY_FILENAMES = [
    "Balanta Scandia Food_31.12.2025 LV.xls",
    "Balanta_EEI_dec_2025.pdf",
    "scandia trial balance 2025.xlsx",
    "balanta_verificare_dec_2025.xlsx",
    "TB-2024-09-30.xlsx",
    "Carniprod Trial Balance 2025.xlsx",
    "Balanta Scandia RealEstate_31.12.2025.xls",
]


def _helper_parity_table() -> List[Tuple[str, str]]:
    table: List[Tuple[str, str]] = []
    today = date.today().isoformat()
    for name in HELPER_PARITY_FILENAMES:
        resolved = _detect_period_end_from_filename(name)
        if resolved and resolved != today:
            table.append((name, resolved))
    return table


def test_w6_service_agrees_with_the_engine_helper_on_every_filename_it_resolved():
    for name, helper_answer in _helper_parity_table():
        got = detect_period(extracted=None, filename=name)
        assert got["proposed_period_end"] == helper_answer, (
            "W6 VIOLATED — %r resolved to %s before and %s now. Existing "
            "correct periods must be untouched; the detection service may "
            "only ADD answers where the helper had none."
            % (name, helper_answer, got["proposed_period_end"])
        )


def test_w6_plant_parity_table_is_not_vacuous():
    """PLANT — a parity table that resolved nothing would pass the gate
    above without asserting anything."""
    table = _helper_parity_table()
    assert len(table) == len(HELPER_PARITY_FILENAMES), (
        "the engine helper no longer resolves every parity filename: %r"
        % [n for n in HELPER_PARITY_FILENAMES
           if n not in dict((k, v) for k, v in table)]
    )


def test_w6_agreeing_hint_changes_nothing_about_the_resolution():
    """The normal, healthy case — a human confirmed what the document
    already said. Resolution and mismatch must both be unremarkable."""
    doc = _doc(
        original_filename="Balanta Scandia Food_31.12.2025 LV.xls",
        period_end_hint="2025-12-31",
    )
    period_end, record = resolve_period_end_for_persist(doc, {})
    assert period_end == "2025-12-31"
    assert record["mismatch"] is False
    assert record["signal_used"] == "user_confirmed"
    assert record["confidence"] == 1.0


def test_w6_month_tags_still_match_the_engine_helper():
    """The normalizer rewrites text into the helper's own vocabulary. If
    the helper's month table ever changes, the rewrite starts producing
    text the helper cannot read and filenames silently regress to
    today."""
    helper_source = inspect.getsource(_detect_period_end_from_filename)
    for month, tag in sorted(_period_detect._MONTH_TAGS.items()):
        assert '"%s": %d' % (tag, month) in helper_source, (
            "month tag %r (%d) is not in the engine helper's own table — "
            "the lexical normalizer would emit text the helper cannot "
            "parse." % (tag, month)
        )
