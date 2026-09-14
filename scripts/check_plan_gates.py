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
     canary;
  2. every canary the entry names is one of that battery gate's canaries,
     and, for the shared runners (vitest, playwright), is also the same
     literal in that runner script's CANARIES array (contract 26);
  3. its plant log (the gates.md heading it names, `## <gate>` by default)
     exists and carries PLANT, RED (plant), REVERT and a SCOPE line;
  4. the parent-commit red: `RED (parent commit)` for a gate that lands
     with its repair, or, for an entry marked registration_only, the line
     "no repair in this commit; registration of an existing test" (0.5);
  5. every contract row it names is one of F1-F10 and S1-S8;
  6. every row a batch lists under required_rows has at least one entry.

It prints the coverage of the eighteen F and S rows (TC-12) and the scope
(TC-13), and a GATE-WORK line the battery reads.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
=========================================
  · an entry whose gate is absent from the battery, has floor 0, or has no
    canary;
  · an entry naming a canary the battery gate (or its runner) does not
    carry;
  · a plant log missing, or missing PLANT, RED (plant), REVERT, SCOPE, or
    its parent-commit red / registration_only line;
  · an unknown contract row, a duplicate entry id, a required row with no
    entry;
  · zero entries, an unreadable registry, battery or plant log (TC-3).

WHAT IT CANNOT SEE
==================
  · whether the recorded red output is true. It checks the record exists;
    the plant was applied and observed by the batch that wrote it.
  · whether a gate's canaries are specific enough. That is
    tests/engine/test_gate_canaries.py, over the whole battery.
  · a gate the contract names that no entry lists. The final census (B21)
    lists every F and S row under required_rows, which closes that hole.

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
    failures = []  # type: List[str]
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

    entries = registry.get("gates") or []
    if not entries:
        failures.append("plan_gates.json lists ZERO gates. A census over nothing "
                        "is a broken census, not a clean one (TC-3).")

    seen = set()  # type: set
    covered = dict((row, []) for row in CONTRACT_ROWS)  # type: Dict[str, List[str]]
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

        for row in entry.get("rows") or []:
            if row in covered:
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
        if gate is None:
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
            for canary in entry.get("canaries") or []:
                if canary not in gate.canaries:
                    failures.append("%s: canary %r is not among battery gate %r's "
                                    "canaries" % (where, canary, gate_name))
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
        report.append("  entry %-28s gate %-26s rows %-10s %s"
                      % (gid, gate_name, ",".join(entry.get("rows") or []),
                         "registration_only" if entry.get("registration_only")
                         else "lands with repair"))

    required = registry.get("required_rows") or {}
    for batch in sorted(required):
        for row in required[batch]:
            if row not in covered:
                failures.append("required_rows[%s]: unknown contract row %r"
                                % (batch, row))
            elif not covered[row]:
                failures.append("required_rows[%s]: row %s has no registered gate"
                                % (batch, row))

    report.append("  coverage of the %d contract rows (TC-12):" % len(CONTRACT_ROWS))
    for row in CONTRACT_ROWS:
        report.append("    %-4s %s" % (row, ", ".join(covered[row]) or "no gate yet"))
    report.append("  rows with a gate: %d/%d; required so far: %s"
                  % (sum(1 for r in CONTRACT_ROWS if covered[r]), len(CONTRACT_ROWS),
                     ", ".join("%s=%s" % (b, "+".join(required[b]))
                               for b in sorted(required)) or "none"))
    report.append("GATE-WORK plan-gate-census units=%d rows=%d"
                  % (len(entries), sum(1 for r in CONTRACT_ROWS if covered[r])))
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
