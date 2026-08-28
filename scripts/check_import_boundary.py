#!/usr/bin/env python3
"""Import/read boundary check for the serving gateway (canonical_bs v2).

The serving gateway (``src/engine/serving/`` — public API: ``engine.serving.facts``)
is the ONLY sanctioned reader of raw canonical/envelope totals. Everything else in
the engine must consume served facts through the gateway, and everything in the
frontend must consume them through ``frontend/lib/servedFacts.ts``. This script
enforces that boundary statically:

ENGINE HALF (AST-based, src/engine/**/*.py outside src/engine/serving/):
  E-SERVING-INTERNAL-IMPORT
      ``import engine.serving.<internal>`` / ``from engine.serving.<internal>
      import ...`` for anything other than the public gateway API
      (``engine.serving`` / ``engine.serving.facts``). Relative imports are
      resolved to absolute module paths before the check.
  E-TOTALS-READ
      ``<envelope-like>["totals"]`` subscript READ (Load context only —
      builder-side writes are Store context and never flagged).
  E-TOTALS-GET
      ``<envelope-like>.get("totals")``.
  E-TOTALS-FIELD
      chained ``[...]["totals"]["assets"|"equity"|"liabilities"|
      "equity_plus_liabilities"|"current_assets"|"current_liabilities"]``
      (flagged regardless of base name — the chain itself is the signature).
  E-ASSEMBLED-TOTAL
      ``.assembled_bs["total_*"]`` / ``<assembled-like>["total_*"]`` /
      ``<assembled-like>.get("total_*")``.

  "envelope-like" is a pragmatic heuristic: the base expression's identifier
  tokens contain one of canonical_bs / cbs / envelope / methodology / assembled
  (substring on a token), or a token exactly equal to env / _env. Reads off
  plainly-named locals (``data.get("totals")``) are NOT flagged — the goal is
  catching envelope consumers, not string coincidences.

FRONTEND HALF (regex-based, frontend/**/*.ts|tsx outside servedFacts.ts +
buildBsStatement.ts + tests):
  F-TOTALS-READ     ``.totals.assets`` (and the other totals field names)
  F-DERIVE-TOTALS   ``deriveTotals(`` call sites (the ``function deriveTotals``
                    definition line itself is exempt)
  F-DIFFERENCE      ``.difference`` property reads

GREP GUARD (raw snapshot private field names):
  G-PRIVATE-FIELD   any occurrence of a private snapshot field name (the
      gateway-owned list — see PRIVATE_SNAPSHOT_FIELDS below) outside
      src/engine/serving/ + the allowlist. The authoritative list lives with
      the gateway: if ``src/engine/serving/facts.py`` defines a module-level
      ``PRIVATE_SNAPSHOT_FIELDS = [...]`` it is unioned in (read via AST, no
      import — this script stays stdlib-only and dependency-free).

ALLOWLIST — scripts/import_boundary_allowlist.txt: one repo-relative path
prefix per line, ``#`` comments. Allowlisted paths are exempt from every check
above. The gateway itself, the _reconcile serve internals, the canonical
builder write side, tests/ and scripts/ live there; legacy call sites are
listed with burn-down comments and must not grow.

ACTIVATION — designed for the final tree while staying green mid-build:
  * the engine half activates when ``src/engine/serving/`` exists; otherwise it
    passes trivially with a warning.
  * the frontend half activates when ``frontend/lib/servedFacts.ts`` exists;
    otherwise it passes trivially with a warning.
  * ``--force`` runs every half regardless (survey mode).

Exit codes: 0 = boundary holds (or inactive), 1 = violations, 2 = internal error.
Stdlib only. Python >= 3.9 (uses ast.unparse).
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

REPO = Path(__file__).resolve().parents[1]
ENGINE_ROOT = REPO / "src" / "engine"
SERVING_PKG = ENGINE_ROOT / "serving"
GATEWAY_FILE = SERVING_PKG / "facts.py"
FE_ROOT = REPO / "frontend"
FE_GATEWAY = FE_ROOT / "lib" / "servedFacts.ts"
ALLOWLIST_FILE = REPO / "scripts" / "import_boundary_allowlist.txt"

# Public gateway API — the ONLY engine.serving modules importable from outside.
ALLOWED_SERVING_IMPORTS = {
    "engine.serving",
    "engine.serving.facts",
    "engine.serving.public_summary",
}

TOTAL_FIELD_KEYS = {
    "assets",
    "equity",
    "liabilities",
    "equity_plus_liabilities",
    "current_assets",
    "current_liabilities",
}

# Base-expression heuristic for "this dict is a canonical envelope / methodology
# / canonical_bs / assembled statement". Substring match on identifier tokens.
ENVELOPE_TOKEN_SUBSTRINGS = ("canonical_bs", "cbs", "envelope", "methodology", "assembled")
# "env" must be an exact token — substring would false-positive on os.environ.
ENVELOPE_TOKEN_EXACT = {"env", "_env"}

# Raw snapshot private field names. The gateway owns the authoritative list
# (PRIVATE_SNAPSHOT_FIELDS in src/engine/serving/facts.py, unioned in at
# runtime); this default seeds the mechanism and must stay a subset of it.
DEFAULT_PRIVATE_SNAPSHOT_FIELDS = [
    "_raw_totals",
]

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class Violation:
    __slots__ = ("path", "line", "code", "message")

    def __init__(self, path: Path, line: int, code: str, message: str) -> None:
        self.path = path
        self.line = line
        self.code = code
        self.message = message

    def render(self) -> str:
        rel = self.path.relative_to(REPO).as_posix() if self.path.is_absolute() else str(self.path)
        return "%s:%d: [%s] %s" % (rel, self.line, self.code, self.message)


# ────────────────────────────────────────────────────────────────────
# Allowlist
# ────────────────────────────────────────────────────────────────────

def load_allowlist(path: Path = ALLOWLIST_FILE) -> List[str]:
    if not path.is_file():
        return []
    entries: List[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            entries.append(line.replace("\\", "/").lstrip("/"))
    return entries


def is_allowlisted(path: Path, allowlist: Sequence[str]) -> bool:
    rel = path.relative_to(REPO).as_posix()
    for entry in allowlist:
        if rel == entry or rel.startswith(entry.rstrip("/") + "/"):
            return True
        # Directory-prefix entries may be written without a trailing slash.
        if entry.endswith("/") and rel.startswith(entry):
            return True
    return False


# ────────────────────────────────────────────────────────────────────
# Engine half — AST heuristics
# ────────────────────────────────────────────────────────────────────

def _expr_text(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return ""


def _is_envelope_like(node: ast.AST) -> bool:
    text = _expr_text(node)
    for token in _IDENT_RE.findall(text):
        low = token.lower()
        if low in ENVELOPE_TOKEN_EXACT:
            return True
        for marker in ENVELOPE_TOKEN_SUBSTRINGS:
            if marker in low:
                return True
    return False


def _const_str(node: ast.AST) -> Optional[str]:
    # py3.9: Subscript slice is the expression directly (no ast.Index).
    if isinstance(node, ast.Index):  # pragma: no cover — pre-3.9 trees only
        node = node.value  # type: ignore[attr-defined]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _mentions_assembled(node: ast.AST) -> bool:
    text = _expr_text(node).lower()
    return "assembled" in text


def _module_for_file(py_file: Path) -> str:
    """Dotted module path of a file under src/ (e.g. engine.api.pipeline).
    Tolerates repo-relative and synthetic paths (unit tests)."""
    try:
        parts = list(py_file.relative_to(REPO / "src").with_suffix("").parts)
    except ValueError:
        parts = list(py_file.with_suffix("").parts)
        if "src" in parts:
            parts = parts[parts.index("src") + 1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _resolve_relative(module: Optional[str], level: int, py_file: Path) -> str:
    """Resolve a relative `from ... import` to an absolute module name."""
    if level == 0:
        return module or ""
    pkg_parts = _module_for_file(py_file).split(".")
    if py_file.name != "__init__.py":
        pkg_parts = pkg_parts[:-1]  # containing package
    # level=1 → current package; each extra level pops one more.
    if level - 1 > 0:
        pkg_parts = pkg_parts[: len(pkg_parts) - (level - 1)]
    base = ".".join(p for p in pkg_parts if p)
    if module:
        return (base + "." + module) if base else module
    return base


def _pointer_msg(detail: str) -> str:
    return (
        detail
        + " — read served facts through the gateway public API "
        "(src/engine/serving/facts.py) instead of the raw snapshot."
    )


def scan_python_source(source: str, py_file: Path) -> List[Violation]:
    """AST scan of one engine module. Pure function — unit-testable."""
    violations: List[Violation] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [Violation(py_file, exc.lineno or 0, "E-SYNTAX", "unparseable: %s" % exc)]

    for node in ast.walk(tree):
        # (a) engine.serving internals imports ------------------------------
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                if name.startswith("engine.serving") and name not in ALLOWED_SERVING_IMPORTS:
                    violations.append(Violation(
                        py_file, node.lineno, "E-SERVING-INTERNAL-IMPORT",
                        _pointer_msg("import of gateway internal '%s'" % name)))
        elif isinstance(node, ast.ImportFrom):
            resolved = _resolve_relative(node.module, node.level, py_file)
            if resolved.startswith("engine.serving") and resolved not in ALLOWED_SERVING_IMPORTS:
                violations.append(Violation(
                    py_file, node.lineno, "E-SERVING-INTERNAL-IMPORT",
                    _pointer_msg("from-import of gateway internal '%s'" % resolved)))
            elif resolved in ALLOWED_SERVING_IMPORTS:
                # Importing a private name FROM the public module is still
                # internal surface: from engine.serving.facts import _foo
                for alias in node.names:
                    if alias.name.startswith("_"):
                        violations.append(Violation(
                            py_file, node.lineno, "E-SERVING-INTERNAL-IMPORT",
                            _pointer_msg("import of private name '%s' from %s"
                                         % (alias.name, resolved))))

        # (b) raw totals reads ---------------------------------------------
        elif isinstance(node, ast.Subscript):
            if not isinstance(node.ctx, ast.Load):
                continue  # writes (builder side) are legal by construction
            key = _const_str(node.slice)
            if key is None:
                continue
            if key == "totals" and _is_envelope_like(node.value):
                violations.append(Violation(
                    py_file, node.lineno, "E-TOTALS-READ",
                    _pointer_msg('raw ["totals"] read on %r' % _expr_text(node.value))))
            elif key in TOTAL_FIELD_KEYS:
                base = node.value
                base_key = _const_str(base.slice) if isinstance(base, ast.Subscript) else None
                if base_key == "totals":
                    violations.append(Violation(
                        py_file, node.lineno, "E-TOTALS-FIELD",
                        _pointer_msg('chained ["totals"]["%s"] read' % key)))
            elif key.startswith("total_") and _mentions_assembled(node.value):
                violations.append(Violation(
                    py_file, node.lineno, "E-ASSEMBLED-TOTAL",
                    _pointer_msg('assembled_bs["%s"] read' % key)))

        elif isinstance(node, ast.Call):
            func = node.func
            if not (isinstance(func, ast.Attribute) and func.attr == "get" and node.args):
                continue
            key = _const_str(node.args[0])
            if key is None:
                continue
            if key == "totals" and _is_envelope_like(func.value):
                violations.append(Violation(
                    py_file, node.lineno, "E-TOTALS-GET",
                    _pointer_msg('.get("totals") on %r' % _expr_text(func.value))))
            elif key.startswith("total_") and _mentions_assembled(func.value):
                violations.append(Violation(
                    py_file, node.lineno, "E-ASSEMBLED-TOTAL",
                    _pointer_msg('.get("%s") on assembled statement' % key)))

    return violations


def run_engine_check(allowlist: Sequence[str], force: bool = False) -> Tuple[List[Violation], bool]:
    """Returns (violations, active)."""
    if not SERVING_PKG.is_dir() and not force:
        return [], False
    violations: List[Violation] = []
    for py_file in sorted(ENGINE_ROOT.rglob("*.py")):
        try:
            rel_to_serving = py_file.relative_to(SERVING_PKG)
        except ValueError:
            rel_to_serving = None
        if rel_to_serving is not None:
            continue  # the gateway itself is the write/read authority
        if is_allowlisted(py_file, allowlist):
            continue
        source = py_file.read_text(encoding="utf-8")
        violations.extend(scan_python_source(source, py_file))
    return violations, True


# ────────────────────────────────────────────────────────────────────
# Frontend half — regex heuristics (node-free)
# ────────────────────────────────────────────────────────────────────

FE_PATTERNS = [
    ("F-TOTALS-READ",
     re.compile(r"\.totals\.(?:assets|equity|liabilities|equity_plus_liabilities"
                r"|current_assets|current_liabilities)\b")),
    ("F-DERIVE-TOTALS", re.compile(r"\bderiveTotals\s*\(")),
    ("F-DIFFERENCE", re.compile(r"\.difference\b")),
]
_FE_DEF_RE = re.compile(r"\bfunction\s+deriveTotals\b")


def _fe_pointer(detail: str) -> str:
    return (
        detail
        + " — consume served facts through frontend/lib/servedFacts.ts "
        "(zero local arithmetic on canonical_bs)."
    )


def scan_ts_source(source: str, ts_file: Path) -> List[Violation]:
    violations: List[Violation] = []
    for lineno, line in enumerate(source.splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
            continue  # comments
        for code, pattern in FE_PATTERNS:
            if not pattern.search(line):
                continue
            if code == "F-DERIVE-TOTALS" and _FE_DEF_RE.search(line):
                continue  # the definition itself, not a call site
            violations.append(Violation(
                ts_file, lineno, code, _fe_pointer("raw totals/difference read")))
    return violations


def _fe_files() -> List[Path]:
    files: List[Path] = []
    for ext in ("*.ts", "*.tsx"):
        files.extend(FE_ROOT.rglob(ext))
    out = []
    for f in sorted(files):
        parts = f.relative_to(REPO).parts
        if "node_modules" in parts or "__tests__" in parts:
            continue
        if ".test." in f.name or ".spec." in f.name or f.name.endswith(".d.ts"):
            continue
        out.append(f)
    return out


def run_frontend_check(allowlist: Sequence[str], force: bool = False) -> Tuple[List[Violation], bool]:
    if not FE_GATEWAY.is_file() and not force:
        return [], False
    violations: List[Violation] = []
    for ts_file in _fe_files():
        if ts_file == FE_GATEWAY:
            continue
        if is_allowlisted(ts_file, allowlist):
            continue
        source = ts_file.read_text(encoding="utf-8")
        violations.extend(scan_ts_source(source, ts_file))
    return violations, True


# ────────────────────────────────────────────────────────────────────
# Grep guard — private snapshot field names
# ────────────────────────────────────────────────────────────────────

def load_private_fields() -> List[str]:
    """Default list, unioned with the gateway's own PRIVATE_SNAPSHOT_FIELDS
    (read from src/engine/serving/facts.py via AST — never imported)."""
    fields = list(DEFAULT_PRIVATE_SNAPSHOT_FIELDS)
    if GATEWAY_FILE.is_file():
        try:
            tree = ast.parse(GATEWAY_FILE.read_text(encoding="utf-8"))
        except SyntaxError:
            return fields
        for node in ast.walk(tree):
            targets: List[ast.expr] = []
            if isinstance(node, ast.Assign):
                targets = node.targets
                value = node.value
            elif isinstance(node, ast.AnnAssign) and node.value is not None:
                targets = [node.target]
                value = node.value
            else:
                continue
            for tgt in targets:
                if isinstance(tgt, ast.Name) and tgt.id == "PRIVATE_SNAPSHOT_FIELDS":
                    if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
                        for elt in value.elts:
                            name = _const_str(elt)
                            if name and name not in fields:
                                fields.append(name)
    return fields


def run_private_field_scan(allowlist: Sequence[str], force: bool = False) -> Tuple[List[Violation], bool]:
    if not SERVING_PKG.is_dir() and not force:
        return [], False
    fields = load_private_fields()
    patterns = [(f, re.compile(r"(?<![A-Za-z0-9_])" + re.escape(f) + r"(?![A-Za-z0-9_])"))
                for f in fields]
    violations: List[Violation] = []
    scan_files: List[Path] = []
    for py_file in sorted(ENGINE_ROOT.rglob("*.py")):
        try:
            py_file.relative_to(SERVING_PKG)
            continue
        except ValueError:
            scan_files.append(py_file)
    scan_files.extend(_fe_files())
    for f in scan_files:
        if is_allowlisted(f, allowlist):
            continue
        source = f.read_text(encoding="utf-8")
        for lineno, line in enumerate(source.splitlines(), start=1):
            for field, pattern in patterns:
                if pattern.search(line):
                    violations.append(Violation(
                        f, lineno, "G-PRIVATE-FIELD",
                        _pointer_msg("private snapshot field '%s' referenced outside "
                                     "src/engine/serving/" % field)))
    return violations, True


# ────────────────────────────────────────────────────────────────────
# Entry point
# ────────────────────────────────────────────────────────────────────

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true",
                        help="run every half even when the gateway package / FE "
                             "module does not exist yet (survey mode)")
    args = parser.parse_args(argv)

    allowlist = load_allowlist()
    all_violations: List[Violation] = []

    engine_v, engine_active = run_engine_check(allowlist, force=args.force)
    if not engine_active:
        print("[check_import_boundary] WARNING: src/engine/serving/ does not exist yet "
              "— engine boundary check passes trivially (activates when the gateway "
              "package lands).")
    all_violations.extend(engine_v)

    fe_v, fe_active = run_frontend_check(allowlist, force=args.force)
    if not fe_active:
        print("[check_import_boundary] WARNING: frontend/lib/servedFacts.ts does not "
              "exist yet — frontend boundary check passes trivially (activates when "
              "the FE gateway module lands).")
    all_violations.extend(fe_v)

    grep_v, grep_active = run_private_field_scan(allowlist, force=args.force)
    if grep_active:
        all_violations.extend(grep_v)

    if all_violations:
        print("\nIMPORT BOUNDARY VIOLATIONS (%d):" % len(all_violations))
        for v in all_violations:
            print("  " + v.render())
        print(
            "\nFix: consume served balance-sheet facts through the serving gateway —\n"
            "  engine:   from engine.serving.facts import <public helper>   "
            "(src/engine/serving/facts.py)\n"
            "  frontend: import from frontend/lib/servedFacts.ts\n"
            "Raw envelope/canonical_bs totals reads outside the gateway break the\n"
            "single-authority contract (docs/CANONICAL_BS_V2_CONTRACT.md).\n"
            "Legitimate build-side / serve-internal code belongs in\n"
            "scripts/import_boundary_allowlist.txt (with a reason comment)."
        )
        return 1

    parts = []
    parts.append("engine=%s" % ("OK" if engine_active else "inactive"))
    parts.append("frontend=%s" % ("OK" if fe_active else "inactive"))
    parts.append("private-fields=%s" % ("OK" if grep_active else "inactive"))
    print("[check_import_boundary] boundary holds (%s)" % ", ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
