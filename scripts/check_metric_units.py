#!/usr/bin/env python3
"""Unit-declaration gate — makes the "1553.0%" collision UNWRITABLE.

Production, 2026-08-30: a margin rendered 1553.0% because two layers
each scaled a ratio by 100. The fix made conversion depend on each
metric row's own ``unit``. That fix only holds while every producer
actually DECLARES a unit — so this gate enforces the precondition
rather than trusting it.

RULE
  Every ``{"name": "<metric>", "value": ...}`` dict literal that a
  producer emits MUST carry a ``"unit"`` key. The rule is universal
  (a nameless unit is ambiguous for any metric), and it is strictest
  exactly where the collision bites: names ending in ``_pct`` /
  ``_ratio`` / ``_margin``, which LOOK self-describing and therefore
  invite a reader to guess the scale.

WHY A LINT AND NOT A RUNTIME CHECK
  The rows are written as literals and persisted; by the time a
  consumer sees one, the authoring context is gone. Catching it at the
  source is the only place the author can still answer "which scale?".

Exit 1 with file:line on violation; 0 clean.
"""
from __future__ import annotations

import ast
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_DIRS = [os.path.join(REPO, "src", "engine")]

# Suffixes whose scale is genuinely ambiguous without a declared unit.
AMBIGUOUS_SUFFIXES = ("_pct", "_ratio", "_margin")


def _literal_metric_rows(tree):
    """Yield (lineno, name, has_unit) for dict literals that look like a
    persisted metric row: a literal "name" plus a "value" key."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = []
        for k in node.keys:
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                keys.append(k.value)
        if "name" not in keys or "value" not in keys:
            continue
        name_val = None
        for k, v in zip(node.keys, node.values):
            if (isinstance(k, ast.Constant) and k.value == "name"
                    and isinstance(v, ast.Constant) and isinstance(v.value, str)):
                name_val = v.value
        if name_val is None:
            continue  # dynamic name — nothing to assert about its suffix
        yield node.lineno, name_val, ("unit" in keys)


def main() -> int:
    violations = []
    for root_dir in SCAN_DIRS:
        for dirpath, _dirnames, filenames in os.walk(root_dir):
            if "__pycache__" in dirpath:
                continue
            for fn in filenames:
                if not fn.endswith(".py"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    tree = ast.parse(open(path, encoding="utf-8").read())
                except SyntaxError:
                    continue
                rel = os.path.relpath(path, REPO)
                for lineno, name, has_unit in _literal_metric_rows(tree):
                    if has_unit:
                        continue
                    ambiguous = name.endswith(AMBIGUOUS_SUFFIXES)
                    violations.append((rel, lineno, name, ambiguous))

    if violations:
        # Ambiguous-suffix rows first: those are the collision class.
        violations.sort(key=lambda v: (not v[3], v[0], v[1]))
        print("METRIC UNIT GATE: FAIL (%d row(s) emit a metric without a unit)"
              % len(violations))
        for rel, lineno, name, ambiguous in violations:
            mark = "  AMBIGUOUS-SUFFIX" if ambiguous else ""
            print("  %s:%d  %s%s" % (rel, lineno, name, mark))
        print()
        print('  Fix: add "unit" to the row (e.g. "ratio" for 0..1, "pct"')
        print('  for 0..100, a currency code, "days", "x"). A metric whose')
        print("  scale is not declared WILL eventually be scaled twice.")
        return 1

    print("METRIC UNIT GATE: PASS — every literal metric row declares a unit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
