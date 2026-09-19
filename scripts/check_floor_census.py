#!/usr/bin/env python3
"""THE FLOOR CENSUS — engine half (battery gate `floor-census`).

Owner rule (2026-09-15, re-stated 2026-09-18): absent is never zero and
never a floor. A divisor floored to 1, a coverage ratio that reads 999
when interest is nil, an epsilon swapped in for a zero EBITDA — each
mints a NUMBER a reader believes where the honest answer is a refusal.
Measured before the repair: `max(total_liabilities, 1)` served X4 1500.0
and Z'' 1584.89 on a book with no liabilities; the `999` sentinel scored
coverage 95 on a book with no interest and no EBIT; ROIC over a 1-RON
invested-capital floor printed 1,299,072,170.8 %.

WHAT THIS GATE DOES. A stdlib-`ast` census over an EXPLICIT, PRINTED scope
(TC-13) for the eight substitute classes of the floor sweep
(scratchpad specs/floor_sweep.json, synth.census_gate), plus the soft
CLAMP class and the OR_ZERO ratchet:

  S1 DIVISOR_FLOOR     max(x, <non-zero literal>) reaching a denominator:
                       directly, through a local name assigned from it in
                       the same function, anywhere inside a denominator
                       expression, or as the denominator argument of a
                       registered division helper (safe, safe_ratio,
                       ratio, _div, _pct_of, _safe_div, safe_div).
  S2 OR_FLOOR          `x or <non-zero literal>` reaching a denominator.
  S3 SENTINEL          `a / b if <test naming b> else <numeric literal>`.
  S4 EPSILON_SWAP      `x if x else 1e-k`, `x or 1e-k`.
  S5 HELPER_FLOOR      any call to a registered substitute helper
                       (_at_least, at_least) and the helper's own def.
  S6 NONE_TO_CONSTANT  `if v is None: return <non-zero literal>`.
  S7 DOMAIN_REPLACE    `if name <cmp> expr: name = <expr with a literal>`.
  S8 CONSTANT_PERIOD   a period_days / periodDays key bound to a literal,
                       a `... else 365` fallback, or a literal 365 in a
                       day-count product.
  CLAMP (soft)         min/max with a numeric literal NOT reaching a
                       denominator — legitimate only as a documented band
                       saturation, and only with an allow-list entry.
  OR_ZERO (ratchet)    `x or 0`, `.get(k, 0)` feeding arithmetic: the
                       absent-read-as-zero boundary, held to a baseline.

TWO TIERS, printed on every run:
  · CREDIT TIER (engine/ratios/credit_model.py, credit_pack.py, table.py,
    comparatives/ratio_compare.py): S1-S7 and CLAMP are RED unless the
    exact site carries an allow-list entry. This is the tier ruled on in
    ratios wave three (R-COMPOSITE, R-D1..D4, R-RANGE, C1.9/C2).
  · RATCHET TIER (the rest of the printed scope, and S8 / OR_ZERO
    everywhere): every (file, class) count is held to
    scripts/floor_census_baseline.json. A count ABOVE its baseline is RED
    (a new floor); a count BELOW it is RED too, with the message "tighten
    the baseline to N" — a ratchet whose baseline goes stale lets the
    next regression back up to the old count hide under it. The R-OTHER
    fix list (C2-C10: valuation, briefing, public risk, period days)
    lands wave by wave, each tightening its own rows.

ALLOW-LIST. scripts/floor_census_allowlist.json — entries of
{file, enclosing_function, class, code, legitimacy, reason, evidence}.
`code` is the normalised `ast.unparse` text of the site, NOT a line
number, so an edited allowed line stops matching and re-triggers review.
Legitimacy is one of: true_value, refused_downstream:<file>:<guard text>,
presentation_only:<where>, band_saturation:<file>:<the domain guard's
code text>, threshold_only. A stale entry (no site matches its code), a
missing reason, an unknown legitimacy, or a band_saturation /
refused_downstream whose named guard text is no longer in the file (or
holds no comparison) is RED. Guards are named by TEXT, never by line: an
edit above the site must not go stale for nothing.

SELF-TEST, every run (TC-2, TC-11). tests/engine/fixtures/floor_census/
substitutes.py holds exactly one verbatim pre-fix instance per class
S1-S8; the census must find every one, or the gate is DISCOVERY BROKEN.

Reds on, after the repair (TC-11): `max(total_liab, 1)` re-introduced in
credit_model.py (S1); a `999` sentinel back on coverage (S3); an unlisted
min/max clamp in the credit tier; any of the eight classes going
undetected on the fixture; a missing scope file; a stale allow-list row;
a ratchet row moving in either direction without its baseline moving.

What it cannot see (TC-13): a floor written as arithmetic (`x + 1` used
as a divisor), a literal fed through a variable defined in another
function, or anything outside the printed scope (the FE half is the
TypeScript census, a separate gate).

Exit 0 = PASS, 1 = FAIL, 2 = DISCOVERY BROKEN.
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

REPO = Path(__file__).resolve().parents[1]

# ── the printed scope ────────────────────────────────────────────────────────

CREDIT_TIER: Tuple[str, ...] = (
    "src/engine/ratios/credit_model.py",
    "src/engine/ratios/credit_pack.py",
    "src/engine/ratios/table.py",
    "src/engine/comparatives/ratio_compare.py",
)

RATCHET_TIER: Tuple[str, ...] = (
    "src/engine/api/_valuation.py",
    "src/engine/api/pipeline.py",
    "src/engine/country_packs/ro_romania/chart_of_accounts.py",
    "src/engine/public/intelligence/risk_scoring_engine.py",
    "src/engine/api/frontend.py",
    "src/engine/actions.py",
    "src/engine/api/cfo_ai.py",
    "src/engine/metrics.py",
    "src/engine/api/_benchmark_engine.py",
    "src/engine/api/_industry_classifier.py",
)

SCOPE: Tuple[str, ...] = CREDIT_TIER + RATCHET_TIER

ALLOWLIST = REPO / "scripts" / "floor_census_allowlist.json"
BASELINE = REPO / "scripts" / "floor_census_baseline.json"
FIXTURE = REPO / "tests" / "engine" / "fixtures" / "floor_census" / "substitutes.py"

HARD_CLASSES = ("S1", "S2", "S3", "S4", "S5", "S6", "S7")
RATCHET_ONLY_CLASSES = ("S8", "OR_ZERO")
ALL_CLASSES = HARD_CLASSES + ("CLAMP",) + RATCHET_ONLY_CLASSES

CLASS_NAMES = {
    "S1": "DIVISOR_FLOOR", "S2": "OR_FLOOR", "S3": "SENTINEL_ON_UNDEFINED",
    "S4": "EPSILON_SWAP", "S5": "HELPER_FLOOR", "S6": "NONE_TO_CONSTANT",
    "S7": "DOMAIN_REPLACEMENT", "S8": "CONSTANT_PERIOD", "CLAMP": "CLAMP",
    "OR_ZERO": "OR_ZERO",
}

DIVISION_HELPERS = {"safe", "safe_ratio", "ratio", "_div", "_pct_of", "_safe_div", "safe_div"}
SUBSTITUTE_HELPERS = {"_at_least", "at_least"}
PERIOD_KEYS = {"periodDays", "period_days"}
LEGITIMACIES = ("true_value", "refused_downstream", "presentation_only", "band_saturation", "threshold_only")


# ── helpers ──────────────────────────────────────────────────────────────────

def _num(node: ast.AST) -> Optional[float]:
    """The numeric value of a literal (including a negated one), else None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        inner = _num(node.operand)
        return -inner if inner is not None else None
    return None


def _call_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Name):
            return f.id
        if isinstance(f, ast.Attribute):
            return f.attr
    return None


def _names_in(node: ast.AST) -> Set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _contains(node: ast.AST, target: ast.AST) -> bool:
    return any(n is target for n in ast.walk(node))


def _unparse(node: ast.AST) -> str:
    return " ".join(ast.unparse(node).split())


class Site:
    def __init__(self, file: str, func: str, cls: str, node: ast.AST, note: str = "") -> None:
        self.file, self.func, self.cls, self.node, self.note = file, func, cls, node, note
        self.line = getattr(node, "lineno", 0)
        self.code = _unparse(node)

    def key(self) -> Tuple[str, str, str, str]:
        return (self.file, self.func, self.cls, self.code)

    def __str__(self) -> str:
        return "%s:%d [%s %s] in %s: %s" % (self.file, self.line, self.cls, CLASS_NAMES[self.cls], self.func, self.code)


# ── the census of one function body ──────────────────────────────────────────

class _FunctionCensus:
    """Every substitute class inside ONE function (module level counts as
    the function `<module>`), with denominator reach computed inside it."""

    def __init__(self, file: str, func: str, body: List[ast.AST]) -> None:
        self.file, self.func, self.body = file, func, body
        self.sites: List[Site] = []
        # every subtree that IS a denominator in this function
        self.denominators: List[ast.AST] = []
        # names assigned from a floor expression -> the floor node
        self.assigned_floor: Dict[str, List[Tuple[ast.AST, str]]] = {}

    def run(self) -> List[Site]:
        for stmt in self.body:
            for n in ast.walk(stmt):
                self._collect_denominators(n)
        for stmt in self.body:
            for n in ast.walk(stmt):
                self._classify(n)
        self._resolve_assigned_floors()
        return self.sites

    # denominators: the right operand of / and //, the denominator argument
    # of a registered division helper
    def _collect_denominators(self, n: ast.AST) -> None:
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.FloorDiv)):
            self.denominators.append(n.right)
        name = _call_name(n)
        if name in DIVISION_HELPERS and isinstance(n, ast.Call) and len(n.args) >= 2:
            self.denominators.append(n.args[1])

    def _reaches_denominator(self, node: ast.AST) -> bool:
        return any(_contains(d, node) for d in self.denominators)

    def _floor_literal_of_max(self, n: ast.AST) -> Optional[float]:
        if _call_name(n) == "max" and isinstance(n, ast.Call) and len(n.args) == 2:
            for a in n.args:
                v = _num(a)
                if v is not None and v != 0:
                    return v
        return None

    def _clamp_literal(self, n: ast.AST) -> bool:
        if _call_name(n) in {"max", "min"} and isinstance(n, ast.Call) and len(n.args) >= 2:
            return any(_num(a) is not None for a in n.args)
        return False

    def _or_literal(self, n: ast.AST) -> Optional[float]:
        if isinstance(n, ast.BoolOp) and isinstance(n.op, ast.Or) and len(n.values) >= 2:
            return _num(n.values[-1])
        return None

    def _add(self, cls: str, n: ast.AST, note: str = "") -> None:
        self.sites.append(Site(self.file, self.func, cls, n, note))

    def _classify(self, n: ast.AST) -> None:
        # S5 helper floor (call or def)
        if _call_name(n) in SUBSTITUTE_HELPERS:
            self._add("S5", n)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in SUBSTITUTE_HELPERS:
            self._add("S5", ast.parse("def %s(): ..." % n.name).body[0], "definition")
        # S1 / CLAMP
        floor = self._floor_literal_of_max(n)
        if floor is not None and self._reaches_denominator(n):
            self._add("S1", n)
        elif self._clamp_literal(n):
            self._add("CLAMP", n)
        # S2 / S4 / OR_ZERO on `or`
        orlit = self._or_literal(n)
        if orlit is not None:
            if 0 < abs(orlit) < 1e-3:
                self._add("S4", n)
            elif orlit != 0 and self._reaches_denominator(n):
                self._add("S2", n)
            elif orlit == 0 and self._feeds_arithmetic(n):
                self._add("OR_ZERO", n)
        # OR_ZERO via .get(k, 0)
        if (_call_name(n) == "get" and isinstance(n, ast.Call) and len(n.args) == 2
                and _num(n.args[1]) == 0 and self._feeds_arithmetic(n)):
            self._add("OR_ZERO", n)
        # S3 / S4 / S8 on IfExp
        if isinstance(n, ast.IfExp):
            lit = _num(n.orelse)
            if lit is not None:
                if lit == 365 or lit == 366:
                    self._add("S8", n, "period fallback")
                elif 0 < abs(lit) < 1e-3 and _names_in(n.test) & _names_in(n.body):
                    self._add("S4", n)
                elif self._body_divides(n.body) and (_names_in(n.test) & self._body_denominator_names(n.body)):
                    self._add("S3", n)
        # S6 `if v is None: return c`
        if isinstance(n, ast.If) and isinstance(n.test, ast.Compare) and len(n.test.ops) == 1 \
                and isinstance(n.test.ops[0], ast.Is) and isinstance(n.test.comparators[0], ast.Constant) \
                and n.test.comparators[0].value is None and len(n.body) == 1 \
                and isinstance(n.body[0], ast.Return) and n.body[0].value is not None:
            v = _num(n.body[0].value)
            if v is not None and v != 0:
                self._add("S6", n.body[0], "guard: %s" % _unparse(n.test))
        # S7 `if name <cmp> expr: name = <expr with literal>`
        if isinstance(n, ast.If) and isinstance(n.test, ast.Compare) and isinstance(n.test.left, ast.Name) \
                and len(n.body) == 1 and isinstance(n.body[0], ast.Assign) and len(n.body[0].targets) == 1 \
                and isinstance(n.body[0].targets[0], ast.Name) and n.body[0].targets[0].id == n.test.left.id \
                and any(_num(c) not in (None, 0) for c in ast.walk(n.body[0].value) if isinstance(c, ast.Constant)) \
                and not isinstance(n.body[0].value, ast.Constant):
            self._add("S7", n.body[0], "guard: %s" % _unparse(n.test))
        # S8 dict key bound to a literal, and a literal 365 in a product
        if isinstance(n, ast.Dict):
            for k, v in zip(n.keys, n.values):
                if isinstance(k, ast.Constant) and k.value in PERIOD_KEYS and v is not None and _num(v) is not None:
                    self._add("S8", n if len(n.keys) == 1 else ast.parse("{%r: %s}" % (k.value, _unparse(v))).body[0].value,
                              "dict key")
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mult) and (_num(n.left) == 365 or _num(n.right) == 365):
            self._add("S8", n, "day-count product")
        # record floors assigned to names (for S1/S2 reach through a local)
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            val = n.value
            if self._floor_literal_of_max(val) is not None:
                self.assigned_floor.setdefault(n.targets[0].id, []).append((n, "S1"))
            elif (self._or_literal(val) not in (None, 0)) and not (0 < abs(self._or_literal(val) or 0) < 1e-3):
                self.assigned_floor.setdefault(n.targets[0].id, []).append((n, "S2"))

    def _resolve_assigned_floors(self) -> None:
        """A floor assigned to a local that is later a denominator is S1/S2
        at the ASSIGNMENT; the same node is then not also a CLAMP."""
        den_names: Set[str] = set()
        for d in self.denominators:
            den_names |= _names_in(d)
        for name, entries in self.assigned_floor.items():
            if name not in den_names:
                continue
            for assign, cls in entries:
                self.sites = [s for s in self.sites if not (s.node is assign.value and s.cls == "CLAMP")]
                self._add(cls, assign, "reaches a denominator through `%s`" % name)

    def _body_divides(self, body: ast.AST) -> bool:
        return any(
            (isinstance(m, ast.BinOp) and isinstance(m.op, (ast.Div, ast.FloorDiv))) or _call_name(m) in DIVISION_HELPERS
            for m in ast.walk(body)
        )

    def _body_denominator_names(self, body: ast.AST) -> Set[str]:
        names: Set[str] = set()
        for m in ast.walk(body):
            if isinstance(m, ast.BinOp) and isinstance(m.op, (ast.Div, ast.FloorDiv)):
                names |= _names_in(m.right)
            if _call_name(m) in DIVISION_HELPERS and isinstance(m, ast.Call) and len(m.args) >= 2:
                names |= _names_in(m.args[1])
        return names

    def _feeds_arithmetic(self, n: ast.AST) -> bool:
        """The `or 0` / `.get(k, 0)` is an operand of an arithmetic BinOp
        somewhere in this function (a looser read than 'reaches a
        denominator' — this is the absent-as-zero ratchet, not a floor)."""
        for stmt in self.body:
            for m in ast.walk(stmt):
                if isinstance(m, ast.BinOp) and isinstance(m.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv)):
                    if _contains(m.left, n) or _contains(m.right, n):
                        return True
        return False


def census_file(rel: str, source: str) -> List[Site]:
    tree = ast.parse(source, filename=rel)
    sites: List[Site] = []
    funcs: List[Tuple[str, List[ast.AST]]] = []
    module_level: List[ast.AST] = []

    def walk(node: ast.AST, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                funcs.append((prefix + child.name, list(child.body) + [child]))
                walk(child, prefix + child.name + ".")
            elif isinstance(child, ast.ClassDef):
                walk(child, prefix + child.name + ".")

    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        module_level.append(stmt)
    walk(tree, "")
    # a nested function's body is censused under ITS name only
    nested_bodies: Set[int] = set()
    for _name, body in funcs:
        for b in body[:-1]:
            for m in ast.walk(b):
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    nested_bodies.add(id(m))
    for name, body in funcs:
        own = body[-1]
        assert isinstance(own, (ast.FunctionDef, ast.AsyncFunctionDef))
        if own.name in SUBSTITUTE_HELPERS:
            # the helper's own definition is a site while any caller remains
            sites.append(Site(rel, name, "S5", ast.parse("def %s(): ..." % own.name).body[0], "definition"))
        fc = _FunctionCensus(rel, name, list(body[:-1]))
        # a nested def's body is censused under ITS OWN name only
        sites.extend(s for s in fc.run() if not _inside_nested(s.node, own))
    if module_level:
        sites.extend(_FunctionCensus(rel, "<module>", module_level).run())
    return sites


def _inside_nested(node: ast.AST, func: ast.AST) -> bool:
    for m in ast.walk(func):
        if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m is not func and _contains(m, node):
            return True
    return False


# ── allow-list and baseline ──────────────────────────────────────────────────

def load_allowlist() -> List[Dict[str, Any]]:
    if not ALLOWLIST.is_file():
        return []
    return json.loads(ALLOWLIST.read_text(encoding="utf-8"))["entries"]


def load_baseline() -> Dict[str, Dict[str, int]]:
    if not BASELINE.is_file():
        return {}
    return json.loads(BASELINE.read_text(encoding="utf-8"))["counts"]


def validate_entry(e: Dict[str, Any], sites_by_key: Dict[Tuple[str, str, str, str], Site], sources: Dict[str, str]) -> List[str]:
    problems: List[str] = []
    for k in ("file", "enclosing_function", "class", "code", "legitimacy", "reason", "evidence"):
        if not e.get(k):
            problems.append("allow-list entry missing `%s`: %r" % (k, e))
    if problems:
        return problems
    leg = e["legitimacy"].split(":", 1)[0]
    if leg not in LEGITIMACIES:
        problems.append("unknown legitimacy %r (one of %s)" % (e["legitimacy"], ", ".join(LEGITIMACIES)))
    key = (e["file"], e["enclosing_function"], e["class"], " ".join(e["code"].split()))
    if key not in sites_by_key:
        problems.append("STALE allow-list entry (no site matches): %s %s [%s] %s"
                        % (e["file"], e["enclosing_function"], e["class"], e["code"]))
        return problems
    if leg in ("band_saturation", "refused_downstream"):
        # the named guard must EXIST in the site's file, by its code text
        # (never a line number: an edit above the site would go stale for
        # nothing), and it must be a comparison on the way to the site.
        loc = e["legitimacy"].split(":", 1)[1] if ":" in e["legitimacy"] else ""
        gfile, _sep, gcode = loc.partition(":")
        gcode = " ".join(gcode.split())
        src = sources.get(gfile)
        if src is None:
            try:
                src = (REPO / gfile).read_text(encoding="utf-8")
            except Exception:
                src = None
        if not gcode or src is None or gcode not in " ".join(src.split()):
            problems.append("%s entry names a guard that is not in %s: %r" % (leg, gfile or "?", gcode))
            return problems
        if not any(op in gcode for op in ("<", ">", "==", "!=", " in ", " is ")):
            problems.append("%s guard holds no comparison: %r" % (leg, gcode))
    return problems


# ── self-test ────────────────────────────────────────────────────────────────

def self_test() -> Tuple[bool, List[str]]:
    lines: List[str] = []
    if not FIXTURE.is_file():
        return False, ["DISCOVERY BROKEN: self-test fixture missing: %s" % FIXTURE]
    sites = census_file(str(FIXTURE.relative_to(REPO)), FIXTURE.read_text(encoding="utf-8"))
    found = {s.cls for s in sites}
    ok = True
    for cls in HARD_CLASSES + ("S8",):
        hit = [s for s in sites if s.cls == cls]
        if hit:
            lines.append("  self-test %s %-22s found: %s" % (cls, CLASS_NAMES[cls], hit[0].code))
        else:
            ok = False
            lines.append("  self-test %s %-22s NOT FOUND — detection broken" % (cls, CLASS_NAMES[cls]))
    lines.append("  self-test classes found: %s" % ", ".join(sorted(found)))
    return ok, lines


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write-baseline", action="store_true",
                    help="rewrite scripts/floor_census_baseline.json from the current counts (a deliberate, named commit)")
    ap.add_argument("--list", action="store_true", help="print every site found, allowed or not")
    args = ap.parse_args(list(argv) if argv is not None else None)

    print("FLOOR CENSUS (engine half) — scope, printed:")
    for rel in SCOPE:
        print("  %s  %s" % ("credit " if rel in CREDIT_TIER else "ratchet", rel))
    missing = [rel for rel in SCOPE if not (REPO / rel).is_file()]
    if missing:
        print("DISCOVERY BROKEN: scope file(s) missing: %s" % ", ".join(missing))
        return 2

    ok, lines = self_test()
    print("SELF-TEST over %s" % FIXTURE.relative_to(REPO))
    for line in lines:
        print(line)
    if not ok:
        print("DISCOVERY BROKEN: the census cannot see every class on its own fixture")
        return 2

    sources = {rel: (REPO / rel).read_text(encoding="utf-8") for rel in SCOPE}
    sites: List[Site] = []
    for rel in SCOPE:
        sites.extend(census_file(rel, sources[rel]))
    sites_by_key = {s.key(): s for s in sites}

    allow = load_allowlist()
    failures: List[str] = []
    for e in allow:
        failures.extend(validate_entry(e, sites_by_key, sources))
    allowed_keys = {(e.get("file"), e.get("enclosing_function"), e.get("class"), " ".join((e.get("code") or "").split()))
                    for e in allow}

    baseline = load_baseline()
    counts: Dict[str, Dict[str, int]] = {}
    hard_red: List[Site] = []
    for s in sites:
        if args.list:
            print("  site %s%s" % (s, "  [ALLOWED]" if s.key() in allowed_keys else ""))
        if s.key() in allowed_keys:
            continue
        if s.file in CREDIT_TIER and s.cls in HARD_CLASSES + ("CLAMP",):
            hard_red.append(s)
        else:
            counts.setdefault(s.file, {}).setdefault(s.cls, 0)
            counts[s.file][s.cls] += 1

    print("CREDIT TIER (S1-S7 + CLAMP red unless allow-listed): %d allow-listed site(s)" % len(allowed_keys))
    for s in hard_red:
        failures.append("FLOOR in the credit tier: %s%s" % (s, (" — " + s.note) if s.note else ""))

    print("RATCHET TIER — (file, class) counts against %s:" % BASELINE.relative_to(REPO))
    all_rows: Set[Tuple[str, str]] = set()
    for f, per in counts.items():
        for c in per:
            all_rows.add((f, c))
    for f, per in baseline.items():
        for c in per:
            all_rows.add((f, c))
    for f, c in sorted(all_rows):
        now = counts.get(f, {}).get(c, 0)
        base = baseline.get(f, {}).get(c)
        mark = "="
        if base is None:
            mark = "NEW"
            failures.append("ratchet: %s [%s %s] has %d site(s) and no baseline row" % (f, c, CLASS_NAMES[c], now))
        elif now > base:
            mark = "UP"
            failures.append("ratchet: %s [%s %s] rose %d -> %d (a new floor)" % (f, c, CLASS_NAMES[c], base, now))
        elif now < base:
            mark = "DOWN"
            failures.append("ratchet: %s [%s %s] fell %d -> %d — tighten the baseline to %d (--write-baseline, named commit)"
                            % (f, c, CLASS_NAMES[c], base, now, now))
        print("  %-4s %-62s %-8s %3d (baseline %s)" % (mark, f, c, now, "-" if base is None else base))

    if args.write_baseline:
        BASELINE.write_text(json.dumps({
            "_": "floor-census ratchet baseline: (file, class) site counts outside the credit tier's hard classes. "
                 "Rewritten only by `scripts/check_floor_census.py --write-baseline` in a named commit; "
                 "the gate reds when a count moves in EITHER direction.",
            "counts": {f: dict(sorted(per.items())) for f, per in sorted(counts.items())},
        }, indent=2) + "\n", encoding="utf-8")
        print("baseline written: %s" % BASELINE.relative_to(REPO))
        return 0

    total = len(sites)
    print("GATE-WORK floor-census units=%d label=candidate-sites scope=%d files credit_tier=%d ratchet_tier=%d"
          % (total, len(SCOPE), len(CREDIT_TIER), len(RATCHET_TIER)))
    if failures:
        print("FAIL floor-census — %d problem(s):" % len(failures))
        for f in failures:
            print("  " + f)
        return 1
    print("PASS floor-census — %d candidate site(s) over %d files; credit tier clean; ratchet held." % (total, len(SCOPE)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
