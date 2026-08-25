"""Format learning loop — layout fingerprint + TemplateStore (Lane 6, Part F).

Locks:
  * fingerprint STABILITY across two saves of the same layout with
    different DATA (real agras fixture vs an in-memory value-perturbed
    re-save) and DISCRIMINATION across layouts (agras vs sibiu vs frozen);
  * TemplateStore CRUD with atomic writes;
  * E7 trust rules — every refusal path: anonymous confirm refused,
    duplicate doc hash never double-counts, promotion bar requires
    >= N confirmations across >= M DISTINCT company keys;
  * lookup serves CONFIRMED entries only — candidates never serve;
  * the no-AI-call-on-hit contract over the lookup path (resolve_map):
    on a template hit the fallback (the interpreter/AI path) is NEVER
    invoked. (The full-lane version of this test belongs to the
    consensus lane's run_dual_map_lane suite.)

No AI client anywhere in this file — the modules under test are pure
bytes/filesystem code.
"""

from __future__ import annotations

import importlib.util
import io
import json
import numbers
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def _load_by_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_engine_module(dotted: str, filename: str):
    """Normal import first; file-path fallback.

    The fallback keeps this suite green even while a SIBLING module of the
    engine.interp package (owned by a concurrent lane) is mid-change —
    fingerprint.py / templates.py have no package-relative imports.
    """
    try:
        module = __import__(dotted, fromlist=["_"])
        return module
    except Exception:  # noqa: BLE001
        return _load_by_path(
            "under_test_%s" % filename.replace(".", "_"),
            SRC / "engine" / "interp" / filename,
        )


fingerprint_mod = _load_engine_module("engine.interp.fingerprint", "fingerprint.py")
templates_mod = _load_engine_module("engine.interp.templates", "templates.py")

layout_fingerprint = fingerprint_mod.layout_fingerprint
FingerprintError = fingerprint_mod.FingerprintError
TemplateStore = templates_mod.TemplateStore
TemplateStoreError = templates_mod.TemplateStoreError
resolve_map = templates_mod.resolve_map

AGRAS = REPO / "files" / "agras_tb_2025.xlsx"
SIBIU = REPO / "files" / "scandia_sibiu_tb_2019.xlsx"
FROZEN = REPO / "files" / "prod_scandia_frozen_31.12.2025.xlsx"

FP_A = "a" * 64
FP_B = "b" * 64
FP_C = "c" * 64

MAP = {"columns": [{"index": 0, "semantic": "account_code"}], "header_row": 0}
CREATED_FROM = {
    "roles": ["interp_a", "interp_b"],
    "prompt_versions": ["structmap_v1"],
    "map_hash": "deadbeef",
}


def _fixture_bytes(path: Path) -> bytes:
    if not path.is_file():
        pytest.skip("fixture not present in this checkout: %s" % path.name)
    return path.read_bytes()


# ── fingerprint: shape + determinism ─────────────────────────────────


def test_fingerprint_is_sha256_hex_and_repeatable():
    data = _fixture_bytes(AGRAS)
    fp1 = layout_fingerprint(data)
    fp2 = layout_fingerprint(data)
    assert fp1 == fp2
    assert len(fp1) == 64
    assert all(c in "0123456789abcdef" for c in fp1)


def test_fingerprint_explicit_sheet_matches_default_first_sheet():
    data = _fixture_bytes(SIBIU)
    assert layout_fingerprint(data) == layout_fingerprint(data, sheet="Sheet1")
    assert layout_fingerprint(data) == layout_fingerprint(data, sheet=0)


def test_fingerprint_rejects_empty_and_non_bytes():
    with pytest.raises(FingerprintError):
        layout_fingerprint(b"")
    with pytest.raises(FingerprintError):
        layout_fingerprint("not-bytes")  # type: ignore[arg-type]


# ── fingerprint: stability across DATA, discrimination across LAYOUTS ─


def _value_perturbed_copy(data: bytes) -> bytes:
    """Re-save the same layout with every numeric DATA value changed."""
    pd = pytest.importorskip("pandas")
    xf = pd.ExcelFile(io.BytesIO(data))
    sheet_name = xf.sheet_names[0]
    df = pd.read_excel(xf, sheet_name=sheet_name, header=None, dtype=object)
    for row in range(1, len(df)):
        for col in range(df.shape[1]):
            value = df.iat[row, col]
            if (
                isinstance(value, numbers.Number)
                and not isinstance(value, bool)
                and value == value  # not NaN
            ):
                df.iat[row, col] = float(value) * 3 + 7
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name=sheet_name, header=False, index=False)
    return buf.getvalue()


def test_fingerprint_stable_across_data_perturbation():
    data = _fixture_bytes(AGRAS)
    perturbed = _value_perturbed_copy(data)
    assert perturbed != data  # genuinely a different file...
    assert layout_fingerprint(perturbed) == layout_fingerprint(data)  # ...same layout


def test_fingerprint_discriminates_layouts():
    fps = {
        layout_fingerprint(_fixture_bytes(AGRAS)),
        layout_fingerprint(_fixture_bytes(SIBIU)),
        layout_fingerprint(_fixture_bytes(FROZEN)),
    }
    assert len(fps) == 3


def test_fingerprint_headerless_grid_still_deterministic():
    """No majority-textual row -> deterministic row-0 fallback, not a crash."""
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Sheet1", header=False, index=False)
    data = buf.getvalue()
    assert layout_fingerprint(data) == layout_fingerprint(data)


# ── TemplateStore: CRUD + atomic writes ──────────────────────────────


def test_record_candidate_creates_entry_and_never_clobbers(tmp_path):
    store = TemplateStore(tmp_path)
    entry = store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    assert entry["status"] == "candidate"
    assert entry["structural_map"] == MAP
    assert entry["confirmations"] == []
    assert entry["created_from"] == CREATED_FROM

    # A re-run with a DIFFERENT map returns the existing entry untouched.
    other_map = {"columns": [], "header_row": 5}
    again = store.record_candidate(FP_A, other_map, created_from={})
    assert again["structural_map"] == MAP

    # On-disk file is well-formed JSON; no tmp litter left behind.
    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == ["%s.json" % FP_A]
    raw = json.loads((tmp_path / ("%s.json" % FP_A)).read_text(encoding="utf-8"))
    assert raw["schema"] == "format_template_v1"
    assert raw["fingerprint"] == FP_A


def test_record_candidate_input_validation(tmp_path):
    store = TemplateStore(tmp_path)
    with pytest.raises(TemplateStoreError):
        store.record_candidate(FP_A, {}, created_from=CREATED_FROM)  # empty map
    with pytest.raises(TemplateStoreError):
        store.record_candidate(FP_A, "not-a-dict", created_from=CREATED_FROM)  # type: ignore[arg-type]
    with pytest.raises(TemplateStoreError):
        store.record_candidate(FP_A, MAP, created_from="nope")  # type: ignore[arg-type]
    with pytest.raises(TemplateStoreError):
        store.record_candidate("../evil", MAP, created_from=CREATED_FROM)
    with pytest.raises(TemplateStoreError):
        store.record_candidate("ABC123", MAP, created_from=CREATED_FROM)


def test_env_override_directs_default_root(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_TEMPLATES_DIR", str(tmp_path / "custom"))
    store = TemplateStore()
    assert store.root == tmp_path / "custom"
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    assert (tmp_path / "custom" / ("%s.json" % FP_A)).is_file()


# ── E7: lookup serves CONFIRMED only ─────────────────────────────────


def test_lookup_candidate_never_serves(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    assert store.lookup(FP_A) is None  # candidate == miss
    assert store.lookup(FP_B) is None  # unknown == miss
    stats = store.stats()
    assert stats["misses"] == 2
    assert stats["hits"] == 0
    assert stats["interpreter_calls_saved"] == 0


def test_lookup_serves_confirmed_and_counts_hits(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    for i, company in enumerate(["co1", "co1", "co2"]):
        store.confirm(
            FP_A,
            confirmed_by="reviewer@example.com",
            doc_content_hash="doc-%d" % i,
            company_key=company,
        )
    store.promote(FP_A, promoted_by="operator@example.com")
    served = store.lookup(FP_A)
    assert served == MAP
    served["columns"] = []  # caller mutation must not leak into the store
    assert store.lookup(FP_A) == MAP
    stats = store.stats()
    assert stats["hits"] == 2
    assert stats["interpreter_calls_saved"] == 2


# ── E7: confirm refusal paths ────────────────────────────────────────


@pytest.mark.parametrize(
    "kwargs",
    [
        {"confirmed_by": "", "doc_content_hash": "d1", "company_key": "co1"},
        {"confirmed_by": "   ", "doc_content_hash": "d1", "company_key": "co1"},
        {"confirmed_by": None, "doc_content_hash": "d1", "company_key": "co1"},
        {"confirmed_by": "alice", "doc_content_hash": "", "company_key": "co1"},
        {"confirmed_by": "alice", "doc_content_hash": "d1", "company_key": ""},
        {"confirmed_by": "alice", "doc_content_hash": "d1", "company_key": "  "},
    ],
    ids=[
        "empty-confirmer",
        "whitespace-confirmer",
        "none-confirmer",
        "empty-doc-hash",
        "empty-company",
        "whitespace-company",
    ],
)
def test_confirm_refuses_blank_identity_fields(tmp_path, kwargs):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    with pytest.raises(TemplateStoreError):
        store.confirm(FP_A, **kwargs)
    assert store.get_entry(FP_A)["confirmations"] == []


def test_confirm_refuses_unknown_fingerprint(tmp_path):
    store = TemplateStore(tmp_path)
    with pytest.raises(TemplateStoreError):
        store.confirm(
            FP_A,
            confirmed_by="alice",
            doc_content_hash="d1",
            company_key="co1",
        )


def test_duplicate_doc_hash_never_double_counts(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    store.confirm(
        FP_A, confirmed_by="alice", doc_content_hash="d1", company_key="co1"
    )
    # Same doc hash again — from a different confirmer AND company, even:
    entry = store.confirm(
        FP_A, confirmed_by="bob", doc_content_hash="d1", company_key="co2"
    )
    assert len(entry["confirmations"]) == 1
    assert entry["confirmations"][0]["confirmed_by"] == "alice"


# ── E7: promotion bar ────────────────────────────────────────────────


def _confirm_n(store, fp, n, companies):
    for i in range(n):
        store.confirm(
            fp,
            confirmed_by="reviewer-%d" % i,
            doc_content_hash="%s-doc-%d" % (fp[:6], i),
            company_key=companies[i % len(companies)],
        )


def test_promotable_requires_n_confirms_and_m_distinct_companies(tmp_path):
    store = TemplateStore(tmp_path)
    # A: 3 confirmations, but all one company — NOT promotable.
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_A, 3, ["solo-co"])
    # B: only 2 confirmations across 2 companies — NOT promotable.
    store.record_candidate(FP_B, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_B, 2, ["co1", "co2"])
    # C: 3 confirmations across 2 companies — promotable.
    store.record_candidate(FP_C, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_C, 3, ["co1", "co2"])

    promotable = store.promotable(3, 2)
    assert [e["fingerprint"] for e in promotable] == [FP_C]


def test_promotable_refuses_degenerate_bar(tmp_path):
    store = TemplateStore(tmp_path)
    with pytest.raises(TemplateStoreError):
        store.promotable(0, 2)
    with pytest.raises(TemplateStoreError):
        store.promotable(3, 0)


def test_promote_refusal_paths(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_A, 3, ["solo-co"])  # below the M-companies half

    with pytest.raises(TemplateStoreError):
        store.promote(FP_A, promoted_by="operator")  # bar not met
    with pytest.raises(TemplateStoreError):
        store.promote(FP_B, promoted_by="operator")  # unknown fingerprint
    with pytest.raises(TemplateStoreError):
        store.promote(FP_A, promoted_by="")  # anonymous promotion
    with pytest.raises(TemplateStoreError):
        store.promote(FP_A, promoted_by="operator", n_confirm=0)  # degenerate bar
    assert store.get_entry(FP_A)["status"] == "candidate"
    assert store.lookup(FP_A, record_stats=False) is None


def test_promote_flips_status_and_leaves_promotable(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_A, 3, ["co1", "co2"])
    assert [e["fingerprint"] for e in store.promotable()] == [FP_A]

    entry = store.promote(FP_A, promoted_by="operator@example.com")
    assert entry["status"] == "confirmed"
    assert entry["promoted_by"] == "operator@example.com"
    assert store.promotable() == []  # confirmed entries leave the queue
    assert store.lookup(FP_A, record_stats=False) == MAP
    # Idempotent re-promote returns the confirmed entry, no error.
    assert store.promote(FP_A, promoted_by="operator2")["status"] == "confirmed"


# ── the no-AI-call-on-hit contract (lookup path unit test) ───────────


def test_resolve_map_hit_never_invokes_fallback(tmp_path):
    store = TemplateStore(tmp_path)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_A, 3, ["co1", "co2"])
    store.promote(FP_A, promoted_by="operator")

    def _forbidden_interpreter():
        raise AssertionError(
            "template HIT must never reach the interpreter/AI path"
        )

    served, outcome = resolve_map(store, FP_A, _forbidden_interpreter)
    assert outcome == "template_hit"
    assert served == MAP


def test_resolve_map_miss_runs_fallback_exactly_once(tmp_path):
    store = TemplateStore(tmp_path)
    calls = []

    def _fallback():
        calls.append(1)
        return {"columns": [], "header_row": 1}

    served, outcome = resolve_map(store, FP_B, _fallback)
    assert outcome == "template_miss"
    assert served == {"columns": [], "header_row": 1}
    assert calls == [1]


# ── report script: exit 0 always + stats file for the ops surface ────


REPORT_SCRIPT = REPO / "scripts" / "report_promotable_templates.py"


def _run_report(tmp_path, extra_env):
    env = dict(**{k: v for k, v in __import__("os").environ.items()})
    env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(REPORT_SCRIPT)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(tmp_path),  # cwd-independence
        check=False,
    )


def test_report_script_empty_store_exits_zero_and_writes_stats(tmp_path):
    templates_dir = tmp_path / "templates"
    obs_dir = tmp_path / "obs"
    result = _run_report(
        tmp_path,
        {
            "ENGINE_TEMPLATES_DIR": str(templates_dir),
            "ENGINE_OBS_DIR": str(obs_dir),
        },
    )
    assert result.returncode == 0, result.stderr
    assert "promotable now: none" in result.stdout
    stats = json.loads((obs_dir / "template_stats.json").read_text("utf-8"))
    assert stats["schema"] == "template_stats_v1"
    for key in (
        "template_count",
        "confirmed",
        "candidates",
        "hits",
        "misses",
        "interpreter_calls_saved",
    ):
        assert key in stats
    assert stats["template_count"] == 0


def test_report_script_lists_promotable_and_procedure(tmp_path):
    templates_dir = tmp_path / "templates"
    obs_dir = tmp_path / "obs"
    store = TemplateStore(templates_dir)
    store.record_candidate(FP_A, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_A, 3, ["co1", "co2"])
    store.record_candidate(FP_B, MAP, created_from=CREATED_FROM)
    _confirm_n(store, FP_B, 3, ["co1", "co2"])
    store.promote(FP_B, promoted_by="operator")

    result = _run_report(
        tmp_path,
        {
            "ENGINE_TEMPLATES_DIR": str(templates_dir),
            "ENGINE_OBS_DIR": str(obs_dir),
        },
    )
    assert result.returncode == 0, result.stderr
    assert FP_A in result.stdout  # the promotable candidate
    assert "OPERATOR PROMOTION PROCEDURE" in result.stdout
    assert "promote(" in result.stdout
    stats = json.loads((obs_dir / "template_stats.json").read_text("utf-8"))
    assert stats["template_count"] == 2
    assert stats["confirmed"] == 1
    assert stats["candidates"] == 1
