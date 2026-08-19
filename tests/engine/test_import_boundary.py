"""Serving-gateway boundary enforcement — in the standard pytest battery.

Three layers:
  1. Runs scripts/check_import_boundary.py as a subprocess against the real
     tree and asserts exit 0 — the same invocation CI runs directly.
  2. Unit-tests the AST/regex heuristics on synthetic sources, so a silently
     broken checker cannot masquerade as a passing boundary.
  3. Grep guard: raw snapshot private field names (gateway-owned list,
     e.g. "_raw_totals") must not appear outside src/engine/serving/ + the
     allowlist (scripts/import_boundary_allowlist.txt).

The checker self-activates on package existence (src/engine/serving/ for the
engine half, frontend/lib/servedFacts.ts for the FE half) so this test stays
green while the gateway is being built in parallel.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_import_boundary.py"
ALLOWLIST = REPO / "scripts" / "import_boundary_allowlist.txt"


def _load_checker():
    spec = importlib.util.spec_from_file_location("check_import_boundary", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="module")
def checker():
    return _load_checker()


# ────────────────────────────────────────────────────────────────────
# 1. The real tree passes (CI parity)
# ────────────────────────────────────────────────────────────────────

def test_boundary_script_exits_zero_on_tree():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, (
        "check_import_boundary.py failed:\n%s\n%s" % (proc.stdout, proc.stderr)
    )


def test_allowlist_file_exists_and_parses(checker):
    assert ALLOWLIST.is_file(), "scripts/import_boundary_allowlist.txt missing"
    entries = checker.load_allowlist()
    assert isinstance(entries, list)
    # The serve internal and the FE canonical renderer are contract-sanctioned.
    assert "src/engine/api/_reconcile.py" in entries
    assert "frontend/lib/buildBsStatement.ts" in entries


# ────────────────────────────────────────────────────────────────────
# 2. Heuristics actually detect the forbidden patterns
# ────────────────────────────────────────────────────────────────────

FAKE = Path("src/engine/api/fake_module.py")


def _codes(checker, source):
    return [v.code for v in checker.scan_python_source(source, FAKE)]


def test_detects_totals_subscript_read(checker):
    assert _codes(checker, 'x = canonical_bs["totals"]\n') == ["E-TOTALS-READ"]
    assert _codes(checker, 'x = _cbs["totals"]\n') == ["E-TOTALS-READ"]


def test_detects_totals_get(checker):
    assert _codes(checker, 'x = envelope.get("totals")\n') == ["E-TOTALS-GET"]
    assert _codes(checker, 'x = methodology.get("totals")\n') == ["E-TOTALS-GET"]
    assert "E-TOTALS-GET" in _codes(
        checker, 'x = (_env.get("methodology") or {}).get("totals")\n')


def test_detects_chained_totals_field_read_regardless_of_base_name(checker):
    codes = _codes(checker, 'x = data["totals"]["equity"]\n')
    assert "E-TOTALS-FIELD" in codes
    for field in ("assets", "liabilities", "equity_plus_liabilities",
                  "current_assets", "current_liabilities"):
        assert "E-TOTALS-FIELD" in _codes(
            checker, 'x = d["totals"]["%s"]\n' % field)


def test_detects_assembled_total_reads(checker):
    assert _codes(checker, 'x = env.assembled_bs["total_assets"]\n') == ["E-ASSEMBLED-TOTAL"]
    assert "E-ASSEMBLED-TOTAL" in _codes(
        checker, 'x = assembled_bs.get("total_equity")\n')


def test_detects_serving_internal_imports(checker):
    assert _codes(checker, "import engine.serving._internal_guard\n") == [
        "E-SERVING-INTERNAL-IMPORT"]
    assert _codes(checker, "from engine.serving import _internal_guard\n") == [
        "E-SERVING-INTERNAL-IMPORT"]
    assert _codes(checker, "from engine.serving.facts import _private_helper\n") == [
        "E-SERVING-INTERNAL-IMPORT"]
    # relative import resolved to absolute before the check
    assert _codes(checker, "from .serving import _internal_guard\n") == []  # api pkg has no serving
    fake_engine_mod = Path("src/engine/fake_module.py")
    codes = [v.code for v in checker.scan_python_source(
        "from .serving import _internal_guard\n", fake_engine_mod)]
    assert codes == ["E-SERVING-INTERNAL-IMPORT"]


def test_public_gateway_import_is_legal(checker):
    assert _codes(checker, "from engine.serving.facts import served_bs_totals\n") == []
    assert _codes(checker, "import engine.serving.facts\n") == []
    assert _codes(checker, "import engine.serving\n") == []


def test_legitimate_code_not_flagged(checker):
    # plainly-named locals are outside the envelope-like heuristic
    assert _codes(checker, 'x = data.get("totals")\n') == []
    assert _codes(checker, 'x = payload["totals"]\n') == []
    # builder-side WRITE (Store context) is legal by construction
    assert _codes(checker, 'canonical_bs["totals"] = totals\n') == []
    # os.environ must not trip the exact-token "env" rule
    assert _codes(checker, 'x = os.environ.get("totals")\n') == []


def test_frontend_heuristics(checker):
    ts = Path("frontend/lib/fake.ts")
    codes = [v.code for v in checker.scan_ts_source(
        "const a = s.canonical_bs.totals.assets;\n"
        "const t = deriveTotals(statements);\n"
        "const d = cbs.difference;\n"
        "// comment mentioning deriveTotals(s) is fine\n"
        "export function deriveTotals(s: Statements): DerivedTotals {\n", ts)]
    assert codes == ["F-TOTALS-READ", "F-DERIVE-TOTALS", "F-DIFFERENCE"]


def test_allowlist_prefix_semantics(checker):
    p = REPO / "src" / "engine" / "api" / "_reconcile.py"
    assert checker.is_allowlisted(p, ["src/engine/api/_reconcile.py"])
    assert checker.is_allowlisted(p, ["src/engine/api/"])
    assert checker.is_allowlisted(p, ["src/engine/api"])
    # prefix must respect path-segment boundaries
    assert not checker.is_allowlisted(p, ["src/engine/ap"])


# ────────────────────────────────────────────────────────────────────
# 3. Grep guard — private snapshot field names stay inside serving/
# ────────────────────────────────────────────────────────────────────

def test_private_snapshot_fields_absent_outside_serving(checker):
    allowlist = checker.load_allowlist()
    violations, active = checker.run_private_field_scan(allowlist, force=True)
    assert active
    assert violations == [], "\n".join(v.render() for v in violations)


def test_private_field_list_includes_raw_totals(checker):
    fields = checker.load_private_fields()
    assert "_raw_totals" in fields
    # When the gateway lands, its own PRIVATE_SNAPSHOT_FIELDS list (in
    # src/engine/serving/facts.py) is unioned in via AST — no import needed.
