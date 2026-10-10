#!/usr/bin/env python3
"""PLAN-GATE CENSUS (plan_contract_v2 F10) — every plan/2 gate is
registered, planted and scoped, or this reds.

WHY THIS EXISTS
===============
plan/2 (one engine for the forecast cockpit and Scenarios) lands its gates
over twenty-odd batches, each appending to shared registries:
scripts/run_battery.py, docs/engine_book/gates.md and
docs/engine_book/plan_gates.json. The failure this census exists for is
the one this repo keeps finding: a gate described in a contract, a plan or
a commit message that nothing actually runs, or runs with no evidence it
can fail. `npx tsc --noEmit` checked zero files for months; forecast
shipped complete and unmounted. A row in plan_gates.json is a claim; this
script checks the claim against the two places that make it true.

WHAT IT CHECKS (contract 26.2 F10), for every entry of plan_gates.json
======================================================================
  1. the entry's battery gate is in scripts/run_battery.py's full gate
     list (engine and frontend), with a floor above zero and at least one
     canary (an entry marked retired_in, allowed only for the retirement
     28.3 names, is exempt: its gate has left the battery on purpose);
  2. every canary the entry names is one of that battery gate's canaries,
     and, for the shared runners (vitest, playwright), is also the same
     literal in that runner script's CANARIES array (contract 26);
  3. its plant log (the gates.md heading it names, `## <gate>` by default)
     exists and carries PLANT, RED (plant), REVERT and a SCOPE line;
  4. the parent-commit red: `RED (parent commit)` for a gate that lands
     with its repair, or, for an entry marked registration_only, the line
     "no repair in this commit; registration of an existing test". Only
     the six B0 registrations contract 0.5 names may be registration_only;
  5. every contract row it names is one of F1-F10 and S1-S8, and its
     landed_in is a batch of 28.3.

And, for the registry as a whole, per BATCH (a batch has landed once it has
a required_rows or required_gates key, or any entry names it in landed_in):

  6. required_gates[<batch>] names every battery gate contract 28.3 says
     that batch registers (CONTRACT_LANDS below; vitest and playwright
     entries use id "<gate>:<batch>"), and each is met ONLY by an entry
     whose landed_in is that batch. A gate registered by an earlier batch
     never satisfies a later batch's requirement;
  7. required_rows[<batch>] names every row whose 26.1 Lands column is that
     batch (CONTRACT_ROW_LANDS), each met only by a live entry landed in
     that batch;
  8. B21, the final census, is the one batch whose requirements any batch's
     entry meets; its required_gates must name every battery gate of the
     26.1 "Battery gate(s)" column and its required_rows every F and S row.

It prints the coverage of the eighteen F and S rows (TC-12), the batches it
enforced and their required gates (TC-13), and a GATE-WORK line the battery
reads.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
=========================================
  · an entry whose gate is absent from the battery, has floor 0, or has no
    canary;
  · an entry naming a canary the battery gate (or its runner) does not
    carry;
  · a plant log missing, or missing PLANT, RED (plant), REVERT, SCOPE, or
    its parent-commit red / registration_only line;
  · registration_only on any entry other than B0's six; retired_in other
    than the one retirement 28.3 names; an unknown batch or row; a
    duplicate entry id; a schema other than plan_gates/2;
  · a landed batch whose required_gates omits a gate 28.3 says it
    registers, or whose required_rows omits a row 26.1 says it lands;
  · a required gate or row with no entry landed in the requiring batch
    (B5 listing F1 is NOT met by B0's forecast-model entry);
  · a B21 key that does not require every 26.1 battery gate and every row;
  · zero entries, an unreadable registry, battery or plant log (TC-3).

WHAT IT CANNOT SEE
==================
  · whether the recorded red output is true. It checks the record exists;
    the plant was applied and observed by the batch that wrote it.
  · whether a gate's canaries are specific enough. That is
    tests/engine/test_gate_canaries.py, over the whole battery.
  · a batch that registers nothing and adds no key: nothing marks it as
    landed, so its CONTRACT_LANDS are not enforced until B21, which requires
    every 26.1 battery gate. The supporting gates of 26.3 are enforced only
    per batch (a supporting gate a landed batch omits reds; one belonging to
    a batch that never marked itself landed is not seen by B21).
  · an extension ("command extended", "floor raised"): only first
    registrations are in CONTRACT_LANDS. The batch's own gate run shows an
    extension.
  · whether CONTRACT_LANDS still matches the contract text. It is a literal
    reading of 28.3's Registers lines and 26.1, checked only for internal
    consistency (every 26.1 battery gate is landed by some batch).

Plants are applied to COPIES: --battery, --gates-md and --plan-gates point
the census at files in a temporary directory.

Usage:
  python scripts/check_plan_gates.py
  python scripts/check_plan_gates.py --gates-md /tmp/x/gates.md

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
DEFAULT_BATTERY = REPO / "scripts" / "run_battery.py"
DEFAULT_GATES_MD = REPO / "docs" / "engine_book" / "gates.md"
DEFAULT_PLAN_GATES = REPO / "docs" / "engine_book" / "plan_gates.json"

CONTRACT_ROWS = tuple(["F%d" % i for i in range(1, 11)]
                      + ["S%d" % i for i in range(1, 9)])

#: The shared runners whose canaries are file paths registered in the
#: runner script itself (contract 26: "appending its path to that script's
#: CANARIES array and the same literal to the gate's canaries").
RUNNER_SCRIPTS = {
    "vitest": REPO / "scripts" / "check_vitest.mjs",
    "playwright": REPO / "scripts" / "check_playwright.mjs",
}

#: The literal a plan entry's canary takes in the BATTERY gate's canaries,
#: per runner. The runner's CANARIES array holds the bare path; the vitest
#: gate's canary is the line the runner prints for it, "<path>: ran" (owner
#: ruling 2026-09-29, CLAUDE.md §26: the bare path also matched "<path>:
#: NEVER RAN", so a retired file stayed a "seen" canary for a week). The
#: census asks for the form the battery actually reads; a runner absent here
#: keeps the bare literal.
RUNNER_GATE_CANARY = {
    "vitest": "%s: ran",
}

SCHEMA = "plan_gates/2"
FINAL_BATCH = "B21"
BATCHES = tuple(["B%d" % i for i in range(0, 22)] + ["B4a", "B4b"])
#: 28.3 B4 may split into B4a (statements repair) then B4b (pools). Both
#: land what the contract lists under B4.
BATCH_ALIASES = {"B4a": "B4", "B4b": "B4"}

#: The first registration of each battery gate, by batch: a literal reading
#: of every "Registers:" line of contract 28.3 (extensions, floor raises and
#: added canaries of an already-registered gate are not first registrations).
#: vitest and playwright are shared runners: each batch that adds canaries
#: owns its own "<gate>:<batch>" entry.
CONTRACT_LANDS = {
    "B0": ("forecast-model", "forecast-serving-boundary", "forecast-drivers",
           "forecast-ai-write-path", "forecast-boundary", "plan-gate-census"),
    "B1": ("sign-flip", "vitest"),
    "B2": ("forecast-base-parity",),
    "B3": ("forecast-authority", "forecast-defaults"),
    "B4": ("forecast-pools",),
    "B5": ("forecast-balance", "scenario-funding-line", "scenario-cost-behaviour",
           "forecast-magnitude", "period-loader-parity", "forecast-get-b4-parity",
           "forecast-debt-timing"),
    "B6": ("forecast-server-side", "forecast-provenance", "forecast-byte-stability",
           "forecast-latency", "forecast-lever-reach", "scenario-one-engine",
           "scenario-provenance", "forecast-cache", "vitest"),
    "B7": ("forecast-history",),
    "B8": ("forecast-metrics", "scenario-covenants", "scenario-waterfall",
           "scenario-verdict"),
    "B9": ("vitest", "playwright"),
    "B10": ("scenario-copy-swap", "scenario-templates", "scenario-presets"),
    "B11": ("breakeven-reconciles", "forecast-tornado", "forecast-cases-spread",
            "forecast-probe-domain"),
    "B12": ("forecast-dcf",),
    "B13": ("vitest", "playwright", "scenario-closure"),
    "B14": ("vitest",),
    "B15": ("forecast-cases-route",),
    "B16": ("vitest",),
    "B17": ("scenario-brief", "vitest"),
    "B18": ("plan-findings", "vitest"),
    "B19": ("forecast-proposals",),
    "B20": ("forecast-export", "report-pdf-forecast", "vitest"),
    "B21": (),
}  # type: Dict[str, Tuple[str, ...]]

#: The rows whose 26.1 "Lands" column names the batch (as-built B0-3a).
CONTRACT_ROW_LANDS = {
    "B0": ("F5", "F10"), "B1": ("S7",), "B3": ("F3",),
    "B5": ("F1", "F6", "S1", "S3"),
    "B6": ("F2", "F4", "F8", "F9", "S4", "S6"),
    "B9": ("F7",), "B10": ("S2",), "B11": ("S5",), "B13": ("S8",),
}  # type: Dict[str, Tuple[str, ...]]

#: The 26.1 "Battery gate(s)" column, row by row. B21 requires all of them.
#: F7's "forecast-distinct (vitest canaries)" is the vitest gate.
ROW_BATTERY_GATES = {
    "F1": ("forecast-balance", "forecast-model"),
    "F2": ("forecast-server-side", "forecast-boundary", "vitest"),
    "F3": ("forecast-defaults", "vitest"),
    "F4": ("forecast-provenance", "vitest"),
    "F5": ("forecast-ai-write-path",),
    "F6": ("forecast-magnitude", "vitest"),
    "F7": ("vitest",),
    "F8": ("forecast-byte-stability", "vitest"),
    "F9": ("forecast-latency", "playwright"),
    "F10": ("plan-gate-census",),
    "S1": ("scenario-cost-behaviour", "forecast-pools", "vitest"),
    "S2": ("scenario-copy-swap", "vitest"),
    "S3": ("scenario-funding-line", "vitest"),
    "S4": ("scenario-one-engine", "vitest"),
    "S5": ("breakeven-reconciles", "vitest"),
    "S6": ("scenario-provenance", "forecast-cases-spread", "vitest"),
    "S7": ("sign-flip", "vitest"),
    "S8": ("scenario-closure", "plan-gate-census", "playwright"),
}  # type: Dict[str, Tuple[str, ...]]

#: Contract 0.5: the only entries that may be registration_only.
B0_REGISTRATIONS = CONTRACT_LANDS["B0"]

#: Contract 28.3 B5: forecast-get-b4-parity is retired by B6.
RETIREMENTS = {"forecast-get-b4-parity": "B6"}


def _batch(name: Any) -> Optional[str]:
    if not isinstance(name, str) or name not in BATCHES:
        return None
    return BATCH_ALIASES.get(name, name)


def _constants_agree() -> List[str]:
    """CONTRACT_LANDS and ROW_BATTERY_GATES are two readings of one contract:
    every 26.1 battery gate must be first registered by some batch."""
    landed = set(g for gates in CONTRACT_LANDS.values() for g in gates)
    return ["census constants disagree: 26.1 battery gate %r is landed by no "
            "batch in CONTRACT_LANDS" % g
            for g in sorted(set(g for gs in ROW_BATTERY_GATES.values() for g in gs))
            if g not in landed]


REGISTRATION_ONLY_LINE = "no repair in this commit; registration of an existing test"
SECTION_MARKERS = ("PLANT", "RED (plant)", "REVERT", "SCOPE")
PARENT_RED_MARKER = "RED (parent commit)"


def _load_battery(path: Path) -> List[Any]:
    spec = importlib.util.spec_from_file_location("plan_census_battery", str(path))
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load the battery at %s" % path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return list(mod.gate_specs(engine_only=False))


def _sections(text: str) -> Dict[str, str]:
    """{heading text: body} for every `##` and `###` heading. A body runs
    to the next heading of the same or a higher level."""
    lines = text.splitlines()
    heads = []  # type: List[Tuple[int, int, str]]
    for i, line in enumerate(lines):
        m = re.match(r"^(#{2,3})\s+(.+?)\s*$", line)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip("` ")))
    out = {}  # type: Dict[str, str]
    for k, (i, level, title) in enumerate(heads):
        end = len(lines)
        for j, lvl, _t in heads[k + 1:]:
            if lvl <= level:
                end = j
                break
        body = "\n".join(lines[i + 1:end])
        out.setdefault(title, body)
    return out


def census(battery_path: Path, gates_md: Path, plan_gates: Path) -> Tuple[List[str], List[str]]:
    failures = _constants_agree()  # type: List[str]
    report = []  # type: List[str]

    try:
        registry = json.loads(plan_gates.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return ["plan_gates.json unreadable (%s): %s" % (plan_gates, exc)], report
    try:
        doc = gates_md.read_text(encoding="utf-8")
    except OSError as exc:
        return ["gates.md unreadable (%s): %s" % (gates_md, exc)], report
    gates = dict((g.name, g) for g in _load_battery(battery_path))
    if len(gates) < 25:
        failures.append("the battery lists %d gate(s); the registry is not being "
                        "read" % len(gates))
    sections = _sections(doc)
    if registry.get("schema") != SCHEMA:
        failures.append("plan_gates.json schema is %r; this census reads %r "
                        "(required_gates keyed by batch)"
                        % (registry.get("schema"), SCHEMA))

    entries = registry.get("gates") or []
    if not entries:
        failures.append("plan_gates.json lists ZERO gates. A census over nothing "
                        "is a broken census, not a clean one (TC-3).")

    seen = set()  # type: set
    covered = dict((row, []) for row in CONTRACT_ROWS)  # type: Dict[str, List[str]]
    landed = set()  # type: set
    #: the batch keys as written (B4a / B4b kept apart from B4), for the
    #: split rule below
    landed_raw = set()  # type: set
    live = []  # type: List[Dict[str, Any]]
    for entry in entries:
        gid = entry.get("id") or entry.get("gate")
        gate_name = entry.get("gate")
        where = "plan_gates.json entry %r" % gid
        if not gid or not gate_name:
            failures.append("%s: needs 'gate' (and 'id' when the gate is a shared "
                            "runner)" % where)
            continue
        if gid in seen:
            failures.append("%s: duplicate entry id" % where)
        seen.add(gid)

        # plan/2 B6 (census loophole 1): an entry's id is its gate name, or
        # <gate>:<landed_in> on a shared runner. Without this an entry whose
        # id borrowed a required gate's name met required_gates while
        # running another gate.
        want_id = ("%s:%s" % (gate_name, entry.get("landed_in"))
                   if gate_name in RUNNER_SCRIPTS else gate_name)
        if gid != want_id:
            failures.append("%s: id must be %r (the gate name%s); an id is never "
                            "a second name for another gate"
                            % (where, want_id,
                               ", then ':' and landed_in, on a shared runner"
                               if gate_name in RUNNER_SCRIPTS else ""))

        batch = _batch(entry.get("landed_in"))
        if batch is None:
            failures.append("%s: landed_in %r is not a batch of contract 28.3"
                            % (where, entry.get("landed_in")))
        else:
            landed.add(batch)
            landed_raw.add(entry.get("landed_in"))

        retired = entry.get("retired_in")
        if retired is not None and RETIREMENTS.get(gate_name) != retired:
            failures.append("%s: retired_in %r — contract 28.3 names only %s"
                            % (where, retired,
                               ", ".join("%s retired by %s" % kv
                                         for kv in sorted(RETIREMENTS.items()))))
            retired = None

        if entry.get("registration_only") and not (
                batch == "B0" and gid in B0_REGISTRATIONS and gate_name == gid):
            failures.append("%s: registration_only (landed_in %r) — contract 0.5 "
                            "allows it only for the six B0 registrations %s; every "
                            "other gate lands with its repair and records RED "
                            "(parent commit)" % (where, entry.get("landed_in"),
                                                 ", ".join(B0_REGISTRATIONS)))

        for row in entry.get("rows") or []:
            if row in covered:
                if retired is None:
                    covered[row].append(gid)
            elif row != "supporting":
                failures.append("%s: unknown contract row %r (rows are %s-%s, %s-%s, "
                                "or 'supporting')" % (where, row, CONTRACT_ROWS[0],
                                                      CONTRACT_ROWS[9],
                                                      CONTRACT_ROWS[10],
                                                      CONTRACT_ROWS[-1]))
        if not entry.get("rows"):
            failures.append("%s: names no contract row" % where)

        gate = gates.get(gate_name)
        if retired is not None:
            pass  # the gate left the battery on purpose (28.3); plant log kept
        elif gate is None:
            failures.append("%s: battery gate %r is not registered in "
                            "scripts/run_battery.py" % (where, gate_name))
        else:
            if gate.floor < 1:
                failures.append("%s: battery gate %r has floor %d; a floor of zero "
                                "passes a run over nothing" % (where, gate_name,
                                                               gate.floor))
            if not gate.canaries:
                failures.append("%s: battery gate %r names no canary"
                                % (where, gate_name))
            # plan/2 B6 (census loophole 2): a shared runner exists for every
            # batch, so an entry on it proves nothing unless it names the
            # canaries this batch added.
            if gate_name in RUNNER_SCRIPTS and not (entry.get("canaries") or []):
                failures.append("%s: an entry on the shared runner %r names ZERO "
                                "canaries; the runner's own existence is not this "
                                "batch's gate (TC-3)" % (where, gate_name))
            for canary in entry.get("canaries") or []:
                in_gate = RUNNER_GATE_CANARY.get(gate_name, "%s") % canary
                if in_gate not in gate.canaries:
                    failures.append("%s: canary %r is not among battery gate %r's "
                                    "canaries" % (where, in_gate, gate_name))
                runner = RUNNER_SCRIPTS.get(gate_name)
                if runner is not None:
                    try:
                        runner_text = runner.read_text(encoding="utf-8")
                    except OSError:
                        runner_text = ""
                    if canary not in runner_text:
                        failures.append("%s: canary %r is not in %s's CANARIES"
                                        % (where, canary, runner.name))

        heading = entry.get("plant_log") or gate_name
        body = sections.get(heading)
        if body is None:
            failures.append("%s: no plant log — gates.md has no heading %r"
                            % (where, heading))
        else:
            absent = [m for m in SECTION_MARKERS if m not in body]
            if absent:
                failures.append("%s: plant log %r lacks %s" % (where, heading,
                                                               ", ".join(absent)))
            if entry.get("registration_only"):
                if REGISTRATION_ONLY_LINE not in body:
                    failures.append("%s: registration_only, but plant log %r does "
                                    "not carry the line %r" % (where, heading,
                                                               REGISTRATION_ONLY_LINE))
            elif PARENT_RED_MARKER not in body:
                failures.append("%s: plant log %r records no %s — a gate that lands "
                                "with a repair shows the defect red on the parent "
                                "commit (contract 0.5)" % (where, heading,
                                                           PARENT_RED_MARKER))
        live.append({"id": gid, "gate": gate_name, "batch": batch,
                     "id_ok": gid == want_id, "retired_in": retired,
                     "rows": list(entry.get("rows") or []),
                     "retired": retired is not None})
        report.append("  entry %-28s gate %-26s rows %-10s %-4s %s"
                      % (gid, gate_name, ",".join(entry.get("rows") or []),
                         entry.get("landed_in"),
                         "retired_in %s" % retired if retired is not None
                         else "registration_only" if entry.get("registration_only")
                         else "lands with repair"))

    # ── per batch: what 28.3 says it registers, met by its own entries ──
    req_gates = {}  # type: Dict[str, List[str]]
    req_rows = {}  # type: Dict[str, List[str]]
    for field, into in (("required_gates", req_gates), ("required_rows", req_rows)):
        for key, values in sorted((registry.get(field) or {}).items()):
            batch = _batch(key)
            if batch is None:
                failures.append("%s[%s]: not a batch of contract 28.3" % (field, key))
                continue
            landed.add(batch)
            landed_raw.add(key)
            into.setdefault(batch, []).extend(values or [])

    # plan/2 B6 (census loophole 3): a gate is retired BY a batch, so that
    # batch must have landed (an entry or a required_* key of its own). A
    # retired_in naming a future batch switched the battery checks off early.
    for e in live:
        if e["retired_in"] is not None and _batch(e["retired_in"]) not in landed:
            failures.append("plan_gates.json entry %r: retired_in %r names a batch "
                            "that has not landed (landed: %s); the gate stays in "
                            "the battery until the batch that retires it lands"
                            % (e["id"], e["retired_in"],
                               ", ".join(b for b in BATCHES if b in landed)))

    # plan/2 B6 repair (B6V-2e): a registration a batch CARRIED instead of
    # landing is a debt with a name. ``owed`` rows say what, from which batch
    # and which later batch owes it. Until that batch lands the row is
    # printed; once it has landed the row must name the registered gate that
    # closed it, or the census reds. A carry can no longer be dropped by
    # simply leaving it out of required_gates.
    owed = registry.get("owed") or []
    ids = set(e["id"] for e in live)
    for index, row in enumerate(owed):
        where = "plan_gates.json owed[%d]" % index
        if not isinstance(row, dict) or not str(row.get("what") or "").strip():
            failures.append("%s: an owed row states what is owed" % where)
            continue
        carried, owing = _batch(row.get("carried_from")), _batch(row.get("owed_in"))
        if carried is None or carried not in landed:
            failures.append("%s (%s): carried_from %r is not a landed batch"
                            % (where, row["what"], row.get("carried_from")))
        if owing is None or (carried is not None and
                             BATCHES.index(owing) <= BATCHES.index(carried)):
            failures.append("%s (%s): owed_in %r is not a batch after %r"
                            % (where, row["what"], row.get("owed_in"),
                               row.get("carried_from")))
            continue
        closed = row.get("closed_by")
        if closed is not None and closed not in ids:
            failures.append("%s (%s): closed_by %r is not a plan_gates.json entry id"
                            % (where, row["what"], closed))
        if owing in landed and closed is None:
            failures.append("%s: %s was carried from %s and owed in %s, which has "
                            "landed; no closed_by names the gate that carries it"
                            % (where, row["what"], row.get("carried_from"), owing))

    def _met_gate(batch: str, name: str) -> bool:
        # by gate name only, and only by an entry whose id is well formed
        # (loophole 1): an id equal to the name no longer counts on its own.
        return any(e["gate"] == name and e["id_ok"]
                   and (batch == FINAL_BATCH or e["batch"] == batch)
                   for e in live)

    def _met_row(batch: str, row: str) -> bool:
        return any(row in e["rows"] and not e["retired"]
                   and (batch == FINAL_BATCH or e["batch"] == batch)
                   for e in live)

    order = [b for b in BATCHES if b in landed]
    for batch in order:
        must_gates = list(CONTRACT_LANDS.get(batch, ()))
        must_rows = list(CONTRACT_ROW_LANDS.get(batch, ()))
        if batch == FINAL_BATCH:
            must_gates = sorted(set(g for gs in ROW_BATTERY_GATES.values() for g in gs))
            must_rows = list(CONTRACT_ROWS)
        # A batch the contract splits (28.3 B4 -> B4a then B4b, 5.1): its
        # "Registers:" gates belong to the closing half ("everything
        # below"), so they are required once that half — or the batch under
        # its own name — has landed; the opening half registers only what
        # it repairs (plan/2 B4a: statements-anchor-gap).
        halves = sorted(k for k, v in BATCH_ALIASES.items() if v == batch)
        if halves and halves[-1] not in landed_raw and batch not in landed_raw:
            report.append("  %-4s split batch: %s landed, the contract gates %s are "
                          "required once %s lands" % (
                              batch, "+".join(h for h in halves if h in landed_raw),
                              "+".join(must_gates), halves[-1]))
            must_gates = []
        for name in must_gates:
            if name not in req_gates.get(batch, []):
                failures.append("required_gates[%s] omits %r, which contract %s "
                                "says %s registers" % (
                                    batch, name,
                                    "26.1" if batch == FINAL_BATCH else "28.3",
                                    "the final census" if batch == FINAL_BATCH
                                    else batch))
        for row in must_rows:
            if row not in req_rows.get(batch, []):
                failures.append("required_rows[%s] omits %s, whose 26.1 Lands "
                                "column is %s" % (batch, row,
                                                  "every row at B21"
                                                  if batch == FINAL_BATCH else batch))
        for name in req_gates.get(batch, []):
            if not _met_gate(batch, name):
                failures.append("required_gates[%s]: gate %r has no plan_gates.json "
                                "entry%s" % (
                                    batch, name,
                                    " (any batch)" if batch == FINAL_BATCH
                                    else " landed in %s (an earlier batch's entry does "
                                    "not count)" % batch))
        for row in req_rows.get(batch, []):
            if row not in covered:
                failures.append("required_rows[%s]: unknown contract row %r"
                                % (batch, row))
            elif not _met_row(batch, row):
                failures.append("required_rows[%s]: row %s has no registered gate%s"
                                % (batch, row,
                                   " (any batch)" if batch == FINAL_BATCH
                                   else " landed in %s (an earlier batch's entry does "
                                   "not count)" % batch))

    report.append("  coverage of the %d contract rows (TC-12):" % len(CONTRACT_ROWS))
    for row in CONTRACT_ROWS:
        report.append("    %-4s %s" % (row, ", ".join(covered[row]) or "no gate yet"))
    report.append("  rows with a gate: %d/%d" % (
        sum(1 for r in CONTRACT_ROWS if covered[r]), len(CONTRACT_ROWS)))
    report.append("  batches enforced (TC-13): %s" % (", ".join(order) or "none"))
    for batch in order:
        report.append("    %-4s required gates %s; required rows %s" % (
            batch, "+".join(req_gates.get(batch, [])) or "none",
            "+".join(req_rows.get(batch, [])) or "none"))
    report.append("  owed registrations (carried, not dropped): %d" % len(owed))
    for row in owed:
        if isinstance(row, dict):
            report.append("    %s -> %s: %s%s" % (
                row.get("carried_from"), row.get("owed_in"), row.get("what"),
                "" if row.get("closed_by") is None else " [closed by %s]" % row["closed_by"]))
    report.append("GATE-WORK plan-gate-census units=%d rows=%d batches=%d"
                  % (len(entries), sum(1 for r in CONTRACT_ROWS if covered[r]),
                     len(order)))
    return failures, report


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--battery", type=Path, default=DEFAULT_BATTERY)
    ap.add_argument("--gates-md", type=Path, default=DEFAULT_GATES_MD)
    ap.add_argument("--plan-gates", type=Path, default=DEFAULT_PLAN_GATES)
    args = ap.parse_args(argv)

    print("PLAN-GATE CENSUS (plan_contract_v2 F10)")
    print("=" * 62)
    print("scope: %s against %s and %s" % (args.plan_gates.name,
                                         args.battery.name, args.gates_md.name))
    failures, report = census(args.battery, args.gates_md, args.plan_gates)
    for line in report:
        print(line)
    if failures:
        print("\nFAIL — %d plan gate claim(s) not backed by the battery and "
              "its plant log:" % len(failures))
        for f in failures:
            print("  · %s" % f)
        return 1
    print("\nPASS — every listed plan gate is registered, planted and scoped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
