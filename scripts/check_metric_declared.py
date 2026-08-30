#!/usr/bin/env python3
"""Build-time gate: every metric a SURFACE can request must be DECLARED
in the ratio-unit registry.

The failure this closes is silent, which is why it needs a gate rather
than a convention. `unit_for_fact()` returns UNIT_UNKNOWN for a name it
does not know, and UNIT_UNKNOWN is a *refusal* — the correct behaviour
for an unrecognised name, and exactly the wrong outcome for a legitimate
metric someone forgot to declare. The surface then declines to render a
figure it holds. That is how eight real Capsule metrics (equity,
current_assets, working_capital, …) resolved to a refusal in 2026-08:
the code was right, the registry was incomplete, and nothing failed
loudly enough to notice.

So: discover every metric name a surface can ask for, statically, and
assert the registry knows it. A name that is genuinely dimensionless
passes through the suffix conventions in `_ratio_units.unit_for_fact`;
money has no suffix rule by design and must be listed explicitly.

Run: .venv/bin/python scripts/check_metric_declared.py
Wired into scripts/run_battery.py as the `metric-declared` gate.
"""
import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from engine.api._ratio_units import unit_for_fact, UNIT_UNKNOWN  # noqa: E402

# HOW DISCOVERY WORKS, and why it is two mechanisms.
#
# Where a surface keeps an ENUMERABLE registry of what it can serve, ask
# the registry — that is authoritative and cannot drift from the code.
# The Capsule's `METRICS` is exactly that: a frozen MappingProxyType of
# every metric the tool layer will answer for.
#
# Where there is no registry, the request site is a CALL, and the metric
# name is the first POSITIONAL argument — `bag.money("trade_rec", …)`,
# `_money_metric("equity", …)`. An earlier draft of this gate scanned
# keyword arguments only and reported "0 metrics" for the findings
# package, which has hundreds. A census that finds nothing is not a
# passing gate; it is a broken one, so the shapes below are asserted to
# find a known-present name before the census is trusted.

# (callee name, index of the positional argument that names the metric)
CALL_SHAPES = [
    ("money", 0),            # Bag.money(fact, value, label)
    ("_money_metric", 0),    # capsule registry builder
    ("_ratio_metric", 0),
]
# `name=` is DELIBERATELY NOT HERE, and the distinction is the whole
# point of the gate.
#
# A name reaching a Quantity CONSTRUCTOR — `_ratio_units.money(v, cur,
# name="part")`, `count(n, name="matching")`, `days(d,
# name="observed_cycle")` — is an OPERAND LABEL. It exists so a unit
# mismatch inside the ratio law can say which side was wrong, and its
# unit is already fixed by the constructor that built it. Those names
# are internal and never leave the engine.
#
# A name reaching `fact=` on a payload, or `Bag.money(fact, …)`, or a
# frozen registry entry, is a CONSUMER-FACING FACT KEY. A surface can
# ask for it, so the registry must know its unit.
#
# Collapsing the two would be worse than having no gate. Adding "part",
# "whole", "amount", "total" and "matching" to _MONEY_FACTS to make this
# pass would mean a genuinely mistyped fact named `amount` would then
# resolve to money by registry lookup instead of refusing — the exact
# infer-money-by-accident failure the registry exists to prevent.
NAME_KWARGS = ("metric", "fact", "fact_name")
FACT_DICT_NAMES = ("facts_cited", "facts", "fact_units")

SURFACE_DIRS = [
    ("capsule", "src/engine/api/_capsule_tools.py"),
    ("findings", "src/engine/api/findings"),
    ("finding-render", "src/engine/api/_finding.py"),
    ("company-profile", "src/engine/api/_company_profile.py"),
    ("finding-rank", "src/engine/api/_finding_rank.py"),
    ("serving", "src/engine/serving/facts.py"),
    ("benchmarks", "src/engine/api/_benchmark_engine.py"),
]

# A name the census MUST find, per surface, or discovery has silently
# broken. Empty tuple = surface may legitimately declare nothing.
CANARIES = {
    "capsule": ("total_assets",),
    "findings": ("total_assets",),
    "benchmarks": ("ebitda_margin",),
    "serving": ("market_cap",),
}

#: Minimum metric names each surface must yield. THE GLOBAL COUNT CANNOT
#: DO THIS JOB: `total_names` is a set UNION, so an adversarial audit
#: dropped five of the seven surfaces and the census still reported 41
#: names — the same number as with all seven, because the dropped
#: surfaces contributed no unique names. No global floor value would
#: have caught it. A per-surface floor does, and it is asserted AFTER
#: the discovery loop, against the totals, because a check inside the
#: loop cannot fire for a surface the loop never visited.
SURFACE_FLOORS = {
    "capsule": 20,
    "findings": 20,
    "benchmarks": 15,
    "serving": 5,
}


class _Collector(ast.NodeVisitor):
    def __init__(self):
        self.found = []          # (name, lineno)

    def _callee(self, node):
        f = node.func
        if isinstance(f, ast.Attribute):
            return f.attr
        if isinstance(f, ast.Name):
            return f.id
        return None

    def visit_Call(self, node):
        callee = self._callee(node)
        for shape, idx in CALL_SHAPES:
            if callee == shape and len(node.args) > idx:
                a = node.args[idx]
                if isinstance(a, ast.Constant) and isinstance(a.value, str):
                    self.found.append((a.value, node.lineno))
        for kw in node.keywords:
            if kw.arg in NAME_KWARGS and isinstance(kw.value, ast.Constant) \
                    and isinstance(kw.value.value, str):
                self.found.append((kw.value.value, node.lineno))
            if kw.arg in FACT_DICT_NAMES and isinstance(kw.value, ast.Dict):
                for k in kw.value.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        self.found.append((k.value, node.lineno))
        self.generic_visit(node)

    def visit_Assign(self, node):
        targets = []
        for t in node.targets:
            if isinstance(t, ast.Name):
                targets.append(t.id)
            elif isinstance(t, ast.Attribute):
                targets.append(t.attr)
        if any(t in FACT_DICT_NAMES for t in targets) and \
                isinstance(node.value, ast.Dict):
            for k in node.value.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    self.found.append((k.value, node.lineno))
        self.generic_visit(node)


def _registry_metrics():
    """Ask the Capsule's own frozen registry what it can serve."""
    out = {}
    try:
        from engine.api import _capsule_tools as ct
    except Exception:
        return out
    for name, spec in getattr(ct, "METRICS", {}).items():
        fact = getattr(spec, "fact", None)
        if fact:
            out[fact] = ("registry:_capsule_tools.METRICS", 0)
    return out


def _benchmark_registry():
    """`METRIC_DISPLAY` is a plain module-level dict, so the AST scan —
    which matches CALL SHAPES — never saw it.

    That blind spot was live: ten of its seventeen rows resolved to
    UNIT_UNKNOWN, four of them declared `fmt: "currency"`. The gate
    printed `benchmarks  0 metrics  OK` the whole time, and "0 metrics"
    read as "this surface declares nothing" rather than "this gate
    cannot see this surface".

    A registry is authoritative about itself. Ask it."""
    out = {}
    try:
        from engine.api._benchmark_engine import METRIC_DISPLAY
    except Exception:
        return out
    for name in METRIC_DISPLAY:
        out[name] = ("registry:_benchmark_engine.METRIC_DISPLAY", 0)
    return out


def _market_registry():
    """`serving/facts._MARKET_METRICS` — all five of its names were
    undeclared. It is a module-level tuple, invisible for the same
    reason. Read it as source rather than importing, because
    engine.serving.facts pulls in the whole serving stack."""
    out = {}
    path = os.path.join(ROOT, "src/engine/serving/facts.py")
    if not os.path.exists(path):
        return out
    src = open(path, encoding="utf-8").read()
    m = re.search(r"_MARKET_METRICS\s*=\s*[\(\[{](.*?)[\)\]}]", src, re.S)
    if not m:
        return out
    for name in re.findall(r'"([a-z_][a-z0-9_]*)"', m.group(1)):
        out[name] = ("registry:serving.facts._MARKET_METRICS", 0)
    return out
def _py_files(rel):
    full = os.path.join(ROOT, rel)
    if os.path.isfile(full):
        return [full]
    out = []
    for base, _dirs, files in os.walk(full):
        for f in files:
            if f.endswith(".py"):
                out.append(os.path.join(base, f))
    return sorted(out)


def main():
    per_surface = {}
    undeclared = []
    total_names = set()

    # A SURFACE PATH THAT DOES NOT EXIST IS A GATE AIMED AT A GHOST.
    #
    # This loop used to `continue` past a missing path. Two entries had
    # been dead for some time (`_notes.py`, `_alerts.py` — removed from
    # the tree, never removed from here), so the gate silently audited
    # five surfaces while its config claimed seven, and would have gone
    # on doing that if a LIVE surface file were renamed. Same family as
    # a Playwright selector pointed at a deleted element: it passes for
    # the wrong reason. The two dead entries are gone; a missing path is
    # now a failure, not a shrug.
    missing_surfaces = [(s_, r_) for s_, r_ in SURFACE_DIRS
                        if not os.path.exists(os.path.join(ROOT, r_))]
    if missing_surfaces:
        print("DISCOVERY BROKEN — configured surfaces that do not exist:")
        for surface, rel in missing_surfaces:
            print("  %-18s %s" % (surface, rel))
        print("Either the file moved (retarget the entry) or the surface "
              "is gone (delete the entry). Skipping it silently means the "
              "census claims coverage it does not have.")
        return 1

    for surface, rel in SURFACE_DIRS:
        names = {}
        for path in _py_files(rel):
            try:
                tree = ast.parse(open(path, encoding="utf-8").read())
            except SyntaxError as exc:      # a parse error is the gate's problem
                print("PARSE FAIL %s: %s" % (path, exc))
                return 1
            col = _Collector()
            col.visit(tree)
            for name, lineno in col.found:
                # Skip obvious non-metrics: templates, ids, empty.
                if not name or "{" in name or " " in name or "." in name:
                    continue
                names.setdefault(name, (os.path.relpath(path, ROOT), lineno))
        if surface == "capsule":
            names.update(_registry_metrics())
        if surface == "benchmarks":
            names.update(_benchmark_registry())
        if surface == "serving":
            names.update(_market_registry())
        missing_canary = [c for c in CANARIES.get(surface, ()) if c not in names]
        if missing_canary:
            print("DISCOVERY BROKEN for surface %r: canary %r not found. "
                  "The census is not measuring what it claims."
                  % (surface, missing_canary))
            return 1
        per_surface[surface] = names
        total_names |= set(names)
        for name, where in sorted(names.items()):
            if unit_for_fact(name) == UNIT_UNKNOWN:
                undeclared.append((surface, name, where))

    # ── PER-SURFACE FLOORS, asserted AFTER the discovery loop ────────
    # Inside the loop this check cannot fire for a surface the loop never
    # visited, which is precisely the failure it exists to catch.
    starved = []
    for surface, floor in sorted(SURFACE_FLOORS.items()):
        got = len(per_surface.get(surface, {}))
        if got < floor:
            starved.append((surface, got, floor))
    if starved:
        print("DISCOVERY BROKEN — surface(s) yielded fewer metrics than")
        print("their declared floor. The census is not measuring what it")
        print("claims; a global count cannot see this because the totals")
        print("are a SET UNION and a dropped surface adds no new names.")
        for surface, got, floor in starved:
            print("  %-16s %d metric(s), floor %d" % (surface, got, floor))
        return 1

    print("METRIC DECLARATION CENSUS")
    print("=" * 62)
    # PRINT THE CANARIES THAT WERE ACTUALLY SEEN.
    #
    # The canary check above returns 1 when a name is missing, but on the
    # happy path it printed nothing — so nothing downstream (the battery,
    # a reader skimming a log) could tell "the canary held" from "the
    # canary was never evaluated". A gate should say what it found, not
    # only what it objects to.
    for surface, names in sorted(CANARIES.items()):
        if surface in per_surface:
            print("  canary %-14s %s  seen" % (surface, ", ".join(names)))
    for surface, names in per_surface.items():
        bad = [n for n in names if unit_for_fact(n) == UNIT_UNKNOWN]
        status = "OK" if not bad else "UNDECLARED x%d" % len(bad)
        print("  %-16s %3d metrics   %s" % (surface, len(names), status))
    print("-" * 62)
    print("  %d distinct metric names across %d surfaces"
          % (len(total_names), len(per_surface)))

    if undeclared:
        print("")
        print("FAIL — these resolve to UNIT_UNKNOWN, which is a REFUSAL:")
        for surface, name, (path, lineno) in undeclared:
            print("  [%s] %-28s %s:%d" % (surface, name, path, lineno))
        print("")
        print("Fix: add each to the right frozenset in")
        print("  src/engine/api/_ratio_units.py")
        print("(_MONEY_FACTS / _RATIO_FACTS / _PERCENT_FACTS), or rename it")
        print("to follow a house suffix convention. Do NOT relax the")
        print("resolver: UNIT_UNKNOWN refusing an unknown name is correct.")
        return 1

    print("")
    print("PASS — every metric a surface can request is declared.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
