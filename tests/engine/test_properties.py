"""HYPOTHESIS property suite for the canonical_bs v2 pipeline (P1-P9).

Every example is routed through the REAL production chain — never a
mirror of it:

  · deterministic lane: TB row dicts → `TrialBalanceParseResult` (with a
    genuinely computed `compute_source_anchor`) → `attach_closing_result`
    → `RomaniaPack.assemble_parsed_tb` (the same code object
    stage_extract + stage_map compose) → `_reconcile
    .auto_reconcile_envelope` — either directly or via the REAL
    `pipeline.stage_persist` against the fake Supabase admin client
    (reused from tests/engine/test_reconciliation.py) → `_reconcile
    .served_canonical_bs` + `pipeline._apply_envelope_truth_to_statements`
    (the /api/period hook) → `engine.serving.FactsGateway` +
    `present_status`;
  · AI lane: generated canned model JSONs → the REAL `engine.ai_lane
    .run_ai_lane` with the fake scripted client (reused from
    tests/engine/test_ai_lane.py) → the same persist/serve chain.

GENERATORS — synthetic TBs built from REAL RAS account codes: the
account pools are derived at import time from the OMFP-1802 rules pack
(`chart_of_accounts._RULES`), with analytic sub-codes re-verified
against the real `bucket_for`; amounts are integer cents (floats only
at the row boundary, the engine's own convention); optional
currency-scale variants (×100 / ×1000); row-order shuffles; occasional
unmapped codes (verified unmapped against `bucket_for` at import);
class-8 memo rows; pre-/post-closing P&L states. Balanced TBs balance
EXACTLY in cents; near-balanced (0 < ratio <= 0.001) and over-threshold
variants are CONSTRUCTED exactly by injecting a one-sided gap sized
from the base envelope's own denominator (the chain runs once to read
it — a pure, deterministic function).

Every row obeys per-row column coherence: si = 0, st = sf + equal
movement noise on both sides, r = st (a first-year TB), so all four
column pairs balance or diverge TOGETHER and the file's own totals row
(when generated) honestly reflects any injected gap (D1 territory,
never D0).

NO LIVE API CALLS: every path that could reach Anthropic runs under
`_ai_blocked()` (records the attempt, raises before any client
construction, blocks the `anthropic` import, strips the env key) or
`_ai_scripted(...)` (a deterministic in-process proposal). The
Anthropic credit state can never affect this suite.

DETERMINISM / PROFILES — two registered profiles:
  · "ci" (default): bounded example counts, `derandomize=True` — every
    run draws the identical example sequence, so a PR failure reproduces
    exactly on re-run with no seed bookkeeping;
  · "deep" (HYPOTHESIS_PROFILE=deep, the nightly high-count run):
    ~10-15× examples, fresh entropy each run (`derandomize=False`,
    `print_blob=True` so Hypothesis prints a reproduction blob).
Both disable the example database (`database=None`): the ci profile is
derandomized so replay adds nothing, and failures are captured as
quarantine artifacts instead — no stray `.hypothesis/` cache dir in the
repo or CI. Per-property example counts use `prop_settings(pr, deep)`.

FAILURE ARTIFACTS — `quarantine(...)` (an on-failure hook wrapped
around every property body) writes the falsifying input to
`corpus/quarantine/<sha16>/{input.json, property, seed, traceback}`.
Hypothesis replays the SHRUNKEN minimal example last, and the writer
keeps only the most recent artifact per property, so the surviving
directory holds the minimal counterexample. Green runs write nothing
(the directory is created lazily). `corpus/` case files belong to the
corpus builder; this module only ever creates `corpus/quarantine/`.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import traceback as _traceback_mod
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple
from unittest import mock

import pytest

# The property suite needs the dev extra (`pip install -e .[dev]`). The
# tier1 CI job currently installs only `pytest`, and workflows are out
# of this suite's scope — so degrade to a clean module-level SKIP there
# instead of an ImportError that would fail collection for the whole
# battery. Flip the CI install to `.[dev]` to run the properties in CI
# (and set HYPOTHESIS_PROFILE=deep for the nightly high-count run).
hypothesis = pytest.importorskip(
    "hypothesis", reason="hypothesis not installed — pip install -e .[dev]"
)
from hypothesis import HealthCheck, given, settings  # noqa: E402
from hypothesis import strategies as st  # noqa: E402
from hypothesis.errors import UnsatisfiedAssumption  # noqa: E402

import engine.ai_lane as lane
from engine.api import _reconcile
from engine.api import pipeline as _pipeline
from engine.core.country_pack_registry import get_pack
from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.serving import FactsGateway, additive_serve_violations, present_status
from engine.serving.status import SURFACES

REPO = Path(__file__).resolve().parents[2]
PACK = get_pack("RO")

# ── Profiles ───────────────────────────────────────────────────────────

_PROFILE = os.environ.get("HYPOTHESIS_PROFILE", "ci")
_DEEP = _PROFILE == "deep"

settings.register_profile(
    "ci",
    max_examples=30,
    derandomize=True,
    deadline=None,          # the chain runs pandas-free but persist+serve
    database=None,          # examples can exceed the 200ms default on CI
    print_blob=False,
    suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
)
settings.register_profile(
    "deep",
    max_examples=400,
    derandomize=False,
    deadline=None,
    database=None,
    print_blob=True,
    suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
)
settings.load_profile("deep" if _DEEP else "ci")


def prop_settings(pr: int, deep: int) -> settings:
    """Per-property example counts: `pr` on the fast PR profile, `deep`
    on the nightly run. All other knobs match the registered profiles."""
    return settings(
        max_examples=deep if _DEEP else pr,
        derandomize=not _DEEP,
        deadline=None,
        database=None,
        print_blob=_DEEP,
        suppress_health_check=(HealthCheck.too_slow, HealthCheck.data_too_large),
    )


# ── Reused harnesses (loaded by path — one source of truth, no mirrors) ─


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_HERE = Path(__file__).resolve().parent
# Fake Supabase admin used by the REAL stage_persist (same module name as
# test_facts_gateway.py uses so sys.modules dedupes the load).
_trec = _load_by_path("reconciliation_fixture_builders", _HERE / "test_reconciliation.py")
_FakeAdminClient = _trec._FakeAdminClient
# Seeded identity-suite helpers: the 10-col row dict + the honest
# all-rows file-totals summation (class 8 included, like real SAGA).
_tid = _load_by_path("identity_property_generator", _HERE / "test_identity_property.py")
_base_row = _tid._row
_file_totals_for = _tid._file_totals
# AI-lane mocked-client harness: scripted fake Anthropic client + the
# real HU fixture bytes (content-hash source for the audit block).
_tai = _load_by_path("ai_lane_fixture_builders", _HERE / "test_ai_lane.py")
_FakeAiClient = _tai._FakeClient
_FakeAdminCtx = _tai._FakeAdminCtx
_HU_BYTES = _tai.HU_BYTES

_SYNTH_ROW_ID = _reconcile.SYNTHETIC_ROW_ID
_RESULT_ROW_IDS = ("current_year_profit", "current_year_loss")
# Contract section split (docs/CANONICAL_BS_V2_CONTRACT.md `sections`).
_ASSET_SECTIONS = ("non_current_assets", "current_assets", "prepaid_expenses")


def _cents(value: Any) -> int:
    return int(round(float(value or 0) * 100))


def _dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


# ── Quarantine writer (corpus/quarantine/<sha16>/) ─────────────────────

QUARANTINE_ROOT = REPO / "corpus" / "quarantine"
_LAST_QUARANTINE: Dict[str, Path] = {}


def _write_quarantine(property_name: str, payload: Any, tb_text: str) -> Path:
    """Write one falsifying input as corpus/quarantine/<sha16>/ with
    {input.json, property, seed, traceback}. Keeps only the most recent
    artifact per property (Hypothesis replays the shrunken minimal
    example last, so the survivor IS the minimal counterexample)."""
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    sha16 = hashlib.sha256(
        (property_name + "\n" + blob).encode("utf-8")
    ).hexdigest()[:16]
    target = QUARANTINE_ROOT / sha16
    previous = _LAST_QUARANTINE.get(property_name)
    if previous is not None and previous != target and previous.exists():
        shutil.rmtree(previous, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    (target / "input.json").write_text(blob + "\n", encoding="utf-8")
    (target / "property").write_text(property_name + "\n", encoding="utf-8")
    (target / "seed").write_text(
        json.dumps(
            {
                "profile": "deep" if _DEEP else "ci",
                "derandomize": not _DEEP,
                "hypothesis": hypothesis.__version__,
                "note": (
                    "ci profile is derandomized — re-running the property "
                    "reproduces this failure without a seed; input.json is "
                    "the exact falsifying input either way"
                ),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (target / "traceback").write_text(tb_text, encoding="utf-8")
    _LAST_QUARANTINE[property_name] = target
    return target


@contextlib.contextmanager
def quarantine(property_name: str, payload: Any) -> Iterator[None]:
    """On-failure hook: wraps a property body; assertion/exception →
    quarantine artifact written, then re-raised (Hypothesis shrinks as
    usual). `assume()` misses pass through untouched."""
    try:
        yield
    except UnsatisfiedAssumption:
        raise
    except Exception:
        _write_quarantine(property_name, payload, _traceback_mod.format_exc())
        raise


# ── AI containment (no live calls, ever) ───────────────────────────────


@contextlib.contextmanager
def _ai_blocked() -> Iterator[List[int]]:
    """Generalized model-quarantine sentinel: `_ai_propose` is replaced
    by a recorder that raises BEFORE any client could be constructed,
    the `anthropic` module is made unimportable, and the env key is
    stripped. Yields the call list — `calls == []` proves the AI path
    was never entered; a nonempty list records a LEGAL attempt (the
    inconclusive branch) that was safely blocked."""
    calls: List[int] = []

    def _blocked(cbs: Any) -> Dict[str, Any]:
        calls.append(1)
        raise RuntimeError("AI blocked in property suite — no live calls")

    with mock.patch.object(_reconcile, "_ai_propose", _blocked), \
            mock.patch.dict(sys.modules, {"anthropic": None}), \
            mock.patch.dict(os.environ):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        yield calls


@contextlib.contextmanager
def _ai_scripted(target_account: str, amount_cents: int) -> Iterator[None]:
    """Deterministic in-process AI proposal (llm_proposed origin) — the
    accepted-AI path without any client construction."""

    def _propose(cbs: Any) -> Dict[str, Any]:
        return {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": target_account,
            "amount_cents": amount_cents,
            "rationale": "scripted property proposal",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        }

    with mock.patch.object(_reconcile, "_ai_propose", _propose), \
            mock.patch.dict(sys.modules, {"anthropic": None}), \
            mock.patch.dict(os.environ):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        yield


# ── Account pools from the REAL rules pack ─────────────────────────────


def _build_bs_pool() -> List[str]:
    pool = set()
    for rule in coa._RULES:
        prefix = rule.prefix
        if not prefix or not prefix.isdigit() or len(prefix) < 3:
            continue
        if prefix[0] not in "12345":
            continue
        if rule.bucket.startswith("ignore"):
            continue  # 121 control, 581 transit, … — exercised separately
        if coa.bucket_for(prefix) is None:
            continue
        pool.add(prefix)
    assert len(pool) >= 60, "rules-pack BS pool unexpectedly small"
    return sorted(pool)


def _build_pl_pool(class_digit: str) -> List[str]:
    pool = set()
    for rule in coa._RULES:
        prefix = rule.prefix
        if not prefix or not prefix.isdigit() or len(prefix) < 3:
            continue
        if prefix[0] != class_digit:
            continue
        if coa.bucket_for(prefix) is None:
            continue
        pool.add(prefix)
    assert pool, "rules-pack class-%s pool empty" % class_digit
    return sorted(pool)


_BS_CODES = _build_bs_pool()
_PL_EXPENSE_CODES = _build_pl_pool("6")
_PL_REVENUE_CODES = _build_pl_pool("7")
# The agras-413 / carniprod-4282 leak class — verified UNMAPPED against
# the real rule table at import (a rules change that maps one of these
# must fail here loudly, not silently reshape the generator).
_UNMAPPED_POOL = [("413", "sf_d"), ("4282", "sf_d")]
# Reserved gap-injection codes for the guaranteed-R2 constructions —
# kept OUT of the general unmapped pool so the single-unmapped match is
# unique by construction.
_UNMAPPED_GAP_DEBIT = "438"
_UNMAPPED_GAP_CREDIT = "482"
for _code, _side in _UNMAPPED_POOL + [(_UNMAPPED_GAP_DEBIT, ""), (_UNMAPPED_GAP_CREDIT, "")]:
    assert coa.bucket_for(_code) is None, (
        "generator invariant: %s must be unmapped in the rules pack" % _code
    )
_CLASS8_CODES = ["8033", "8036", "8051", "891", "892"]

_SIDE_FLIP = {"sf_d": "sf_c", "sf_c": "sf_d"}


def _natural_side(code: str) -> str:
    """Realism heuristic only — the closing identity must hold for ANY
    side, and the strategy flips ~15% of rows to stress exactly that."""
    c0 = code[0]
    if c0 in ("2", "3"):
        return "sf_c" if code.startswith(("28", "29", "39")) else "sf_d"
    if c0 == "5":
        return "sf_c" if code.startswith(("59", "519", "509")) else "sf_d"
    if c0 == "1":
        return "sf_d" if code.startswith(("129", "169")) else "sf_c"
    # class 4 — receivable families debit, everything else credit
    if code.startswith(("409", "41", "425", "4424", "4426", "445", "446", "461", "471", "473")):
        return "sf_d"
    return "sf_c"


def _mk_row(code: str, side: str, cents: int, movement_cents: int = 0) -> Dict[str, float]:
    """One coherent first-year row: si = 0, sf on `side`, st = sf plus
    equal movement noise on BOTH sides, r = st. Every column pair then
    balances (or diverges) together across the whole TB."""
    sf_d = cents if side == "sf_d" else 0
    sf_c = cents if side == "sf_c" else 0
    st_d = sf_d + movement_cents
    st_c = sf_c + movement_cents
    return _base_row(
        code,
        sf_d=sf_d / 100.0, sf_c=sf_c / 100.0,
        st_d=st_d / 100.0, st_c=st_c / 100.0,
        r_d=st_d / 100.0, r_c=st_c / 100.0,
    )


def _sf_imbalance_cents(rows: List[Dict[str, float]]) -> int:
    d = sum(_cents(r["sf_d"]) for r in rows if not r["cont"].startswith("8"))
    c = sum(_cents(r["sf_c"]) for r in rows if not r["cont"].startswith("8"))
    return d - c


_AMOUNT_CENTS = st.one_of(
    st.integers(1, 99),
    st.integers(100, 9_999),
    st.integers(10_000, 999_999),
    st.integers(1_000_000, 99_999_999),
    st.integers(100_000_000, 500_000_000),
)


@st.composite
def balanced_tb(draw, min_accounts: int = 6, max_accounts: int = 35,
                allow_unmapped: bool = True) -> Dict[str, Any]:
    """One EXACTLY balanced synthetic TB (integer cents) built from real
    rules-pack codes: BS accounts (natural side, ~15% flipped), optional
    analytic sub-codes, optional unmapped codes, P&L rows in pre-/post-
    closing states with 121, class-8 memo rows, an optional ×100/×1000
    currency-scale variant, and a drawn row-order shuffle."""
    scale = draw(st.sampled_from((1, 1, 1, 1, 100, 1000)))
    rows: List[Dict[str, float]] = []

    n_bs = draw(st.integers(min_accounts, max_accounts))
    for _ in range(n_bs):
        code = draw(st.sampled_from(_BS_CODES))
        suffix = draw(st.sampled_from(("", "", "", "01", "1")))
        full = code + suffix
        if coa.bucket_for(full) is None:
            full = code  # analytic fell off the rule table — keep the base
        side = _natural_side(full)
        if draw(st.integers(0, 99)) < 15:
            side = _SIDE_FLIP[side]  # bifunctional / wrong-side stress
        cents = draw(_AMOUNT_CENTS) * scale
        movement = draw(_AMOUNT_CENTS) * scale if draw(st.booleans()) else 0
        rows.append(_mk_row(full, side, cents, movement))

    has_unmapped = allow_unmapped and draw(st.booleans())
    if has_unmapped:
        for code, side in draw(
            st.lists(st.sampled_from(_UNMAPPED_POOL), min_size=1,
                     max_size=len(_UNMAPPED_POOL), unique=True)
        ):
            rows.append(_mk_row(code, side, draw(_AMOUNT_CENTS) * scale))

    # P&L + 121: 0 = post-closing, 1 = pre-closing, 2 = mixed.
    variant = draw(st.integers(0, 2))
    n_pl = draw(st.integers(0, 6))
    for _ in range(n_pl):
        expense = draw(st.booleans())
        code = draw(st.sampled_from(_PL_EXPENSE_CODES if expense else _PL_REVENUE_CODES))
        x = draw(_AMOUNT_CENTS) * scale
        if variant == 0:
            rows.append(_mk_row(code, "sf_d", 0, x))       # closed: SF zero
        else:
            side = "sf_d" if expense else "sf_c"
            noise = draw(_AMOUNT_CENTS) * scale if draw(st.booleans()) else 0
            rows.append(_mk_row(code, side, x, noise))
    if variant in (0, 2):
        side = draw(st.sampled_from(("sf_c", "sf_c", "sf_d")))
        rows.append(_mk_row("121", side, draw(_AMOUNT_CENTS) * scale,
                            draw(_AMOUNT_CENTS) * scale))

    for _ in range(draw(st.integers(0, 2))):
        rows.append(_mk_row(draw(st.sampled_from(_CLASS8_CODES)),
                            draw(st.sampled_from(("sf_d", "sf_c"))),
                            draw(_AMOUNT_CENTS) * scale))

    imbalance = _sf_imbalance_cents(rows)
    if imbalance > 0:
        rows.append(_mk_row("1012", "sf_c", imbalance))
    elif imbalance < 0:
        rows.append(_mk_row("5121", "sf_d", -imbalance))
    assert _sf_imbalance_cents(rows) == 0

    rows = draw(st.permutations(rows))
    return {
        "rows": list(rows),
        "with_totals": draw(st.booleans()),
        "scale": scale,
        "variant": variant,
        "has_unmapped": has_unmapped,
    }


# gap kinds: "zero" (balanced), "sub" (0 < ratio <= 0.001, constructed
# exactly), "over" (ratio > 0.001, constructed exactly).
_GAP_KINDS = ("zero", "sub", "over")


@st.composite
def gapped_tb(draw, kinds: Tuple[str, ...] = _GAP_KINDS) -> Dict[str, Any]:
    case = draw(balanced_tb())
    case["kind"] = draw(st.sampled_from(kinds))
    case["gap_scale"] = draw(st.integers(0, 10**6))      # → delta size
    case["gap_side"] = draw(st.sampled_from(("sf_d", "sf_c")))
    # Mapped injection codes (both sides classifiable): inventory /
    # bank on the debit side, payables / other creditors on credit.
    case["gap_code"] = draw(st.sampled_from(
        ("371", "5311") if case["gap_side"] == "sf_d" else ("401", "462")
    ))
    return case


# ── The REAL chain (parse-shape → assemble → persist → serve) ──────────


def _assembled_for(rows: List[Dict[str, float]],
                   file_totals: Optional[Dict[str, float]]) -> Dict[str, Any]:
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction={
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB_property",
            "header_row_index": 0,
        },
        source_anchor=tbp.compute_source_anchor(
            rows,
            file_totals=file_totals,
            pairs_present=None,
            totals_row_index=None if file_totals is None else 0,
        ),
    )
    PACK.attach_closing_result(tb)
    _tb, _shaped, assembled = PACK.assemble_parsed_tb(
        tb, company_name="Property TB", period_label="PROP",
    )
    return assembled


CONTENT_HASH = "sha256-property-fixture"


def _envelope_for(rows: List[Dict[str, float]],
                  file_totals: Optional[Dict[str, float]],
                  content_hash: str = CONTENT_HASH) -> Dict[str, Any]:
    """Assembled envelope with the provenance stamp stage_persist adds
    (for the direct-call paths; the persist paths get the real stamp)."""
    envelope = _assembled_for(rows, file_totals)["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-prop",
        "original_filename": "balanta_property.xlsx",
        "content_hash": content_hash,
        "written_at": "2026-08-19T00:00:00+00:00",
    }
    return envelope


def _materialize(case: Dict[str, Any]) -> Tuple[List[Dict[str, float]],
                                                Optional[Dict[str, float]], int]:
    """Turn a gapped case into final rows + honest file totals + the
    exactly-constructed delta (signed cents; 0 for kind == "zero").

    The base (balanced) envelope is built once to read the gate
    denominator max(|assets|, |E+L|) — a pure deterministic read, not a
    mirror — then the gap is injected as one extra one-sided row and the
    file totals are recomputed over the FINAL rows, so extraction stays
    faithful and any imbalance is honestly the SOURCE's (D1, never D0).

    sub:  0 < delta <= denom // 1000       ⇒ ratio <= 0.001 post-injection
          (the denominator can only grow by |delta|).
    over: delta >= denom // 999 + 1 (+ extra) ⇒ delta * 999 > denom
          ⇒ delta * 1000 > denom + delta >= post-injection denominator.
    """
    rows = [dict(r) for r in case["rows"]]
    kind = case.get("kind", "zero")
    delta = 0
    if kind != "zero":
        base_cbs = _assembled_for(rows, None)["assembled_canonical_v1"]["canonical_bs"]
        totals = base_cbs["totals"]
        denom = max(abs(_cents(totals.get("assets"))),
                    abs(_cents(totals.get("equity_plus_liabilities"))))
        if kind == "sub":
            cap = denom // 1000
            if cap < 1:
                raise UnsatisfiedAssumption("sheet too small for a sub-gate gap")
            magnitude = 1 + (cap - 1) * case["gap_scale"] // 10**6
        else:
            magnitude = denom // 999 + 1 + (denom // 50) * case["gap_scale"] // 10**6
        side = case["gap_side"]
        rows.append(_mk_row(case["gap_code"], side, magnitude))
        delta = magnitude if side == "sf_d" else -magnitude
    file_totals = _file_totals_for(rows) if case["with_totals"] else None
    return rows, file_totals, delta


@contextlib.contextmanager
def _fake_persist_admin(fake: Any) -> Iterator[None]:
    @contextlib.contextmanager
    def _admin():
        yield fake

    with mock.patch.object(_pipeline._supabase, "admin", _admin):
        yield


def _run_stage_persist(fake: Any, assembled: Dict[str, Any],
                       content_hash: str = CONTENT_HASH) -> Dict[str, Any]:
    """The REAL pipeline.stage_persist against the fake Supabase admin;
    returns the envelope it wrote to financial_periods."""
    with _fake_persist_admin(fake):
        doc = {
            "id": "doc-prop",
            "org_id": "org-prop",
            "original_filename": "balanta_property_31.12.2025.xlsx",
            "content_hash": content_hash,
        }
        parsed = {"period_end": "2025-12-31", "currency": "RON", "confidence": 0.9}
        _pipeline.stage_persist(doc, parsed, assembled)
    writes = [
        patch["assembled_canonical_v1"]
        for table, patch, _f in fake.updates
        if table == "financial_periods" and "assembled_canonical_v1" in patch
    ]
    assert writes, "stage_persist wrote no canonical envelope"
    return writes[-1]


def _serve_statements(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """The REAL /api/period serve hook."""
    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {"revenue": 0.0}}
    _pipeline._apply_envelope_truth_to_statements(
        statements, {"assembled_canonical_v1": envelope}
    )
    return statements


def _case_payload(case: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    payload = dict(case)
    payload.update(extra)
    return payload


# ═══════════════════════════════════════════════════════════════════════
# P1 — source cents never mutate
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(30, 400)
@given(case=gapped_tb())
def test_p1_source_cents_never_mutate(case):
    """The persisted `canonical_bs` (extraction truth) stays
    byte-identical through the ENTIRE journey: auto-reconcile at the
    real persist seam, double serving, the /api/period hook, gateway
    construction, and the status presenter. Receipts land NEXT TO it,
    never inside it."""
    rows, file_totals, _delta = _materialize(case)
    with quarantine("P1_source_cents_never_mutate", _case_payload(case)):
        with _ai_blocked():
            fake = _FakeAdminClient()
            written = _run_stage_persist(fake, _assembled_for(rows, file_totals))
            snapshot = _dumps(written["canonical_bs"])

            _reconcile.served_canonical_bs(written)
            _reconcile.served_canonical_bs(written)
            _serve_statements(written)
            gw = FactsGateway.from_envelope(written)
            assert gw is not None
            served = gw.served_canonical_bs
            present_status(served, surface="api")

            assert _dumps(written["canonical_bs"]) == snapshot
            # A second serve stays byte-identical (hard-refresh purity).
            assert _dumps(_reconcile.served_canonical_bs(written)) == _dumps(served)


# ═══════════════════════════════════════════════════════════════════════
# P2 — adjustments strictly additive
# ═══════════════════════════════════════════════════════════════════════


def _non_synthetic(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [r for r in rows if str(r.get("id") or "") != _SYNTH_ROW_ID]


@prop_settings(30, 400)
@given(case=gapped_tb())
def test_p2_adjustments_strictly_additive(case):
    """At most ONE reconciliation line on the served statement (the
    synthetic BS row XOR a delta-noted result row), extracted leaf
    amounts untouched everywhere else, and the serve mutation is
    additive-only (no key removed or retyped vs the persisted object)."""
    rows, file_totals, _delta = _materialize(case)
    with quarantine("P2_adjustments_strictly_additive", _case_payload(case)):
        with _ai_blocked():
            envelope = _envelope_for(rows, file_totals)
            _reconcile.auto_reconcile_envelope(envelope)
            raw = envelope["canonical_bs"]
            served = _reconcile.served_canonical_bs(envelope)
            receipt = served.get("reconciliation") if served["status"] == "RECONCILED" else None

            assert additive_serve_violations(raw, served) == []

            raw_rows = list(raw.get("rows") or [])
            served_rows = _non_synthetic(list(served.get("rows") or []))
            synthetic_rows = [r for r in (served.get("rows") or [])
                              if str(r.get("id") or "") == _SYNTH_ROW_ID]
            assert len(served_rows) == len(raw_rows)

            delta_noted = 0
            for raw_r, srv_r in zip(raw_rows, served_rows):
                assert srv_r["id"] == raw_r["id"]
                assert srv_r["section"] == raw_r["section"]
                assert srv_r.get("leaf_ids") == raw_r.get("leaf_ids")
                if _cents(srv_r["amount"]) != _cents(raw_r["amount"]):
                    # Only the result row may move, only on an accepted
                    # pnl-placed receipt, only by exactly the delta.
                    delta_noted += 1
                    assert receipt is not None and receipt["placement"] == "pnl"
                    assert srv_r["id"] in _RESULT_ROW_IDS
                    assert (_cents(srv_r["amount"]) - _cents(raw_r["amount"])
                            == int(receipt["amount_cents"]))
                    assert _cents(srv_r["reconciliation_delta"]) == int(receipt["amount_cents"])
                    assert srv_r["reconciliation_note"] == _reconcile.SYNTHETIC_ROW_LABEL

            adjustment_lines = len(synthetic_rows) + delta_noted
            if receipt is None:
                assert adjustment_lines == 0
                assert served["status"] != "RECONCILED"
            else:
                assert adjustment_lines == 1
                for row in synthetic_rows:
                    assert row["synthetic"] is True
                    assert row["leaf_ids"] == [] and row["account_codes"] == []
                    assert row["label"] == _reconcile.SYNTHETIC_ROW_LABEL


@st.composite
def pnl_cause_tb(draw) -> Dict[str, Any]:
    """A sub-threshold drift whose only plausible cause is a class-6/7
    account — the deterministic ladder stays inconclusive by
    construction (delta dodges R1's cent band, no unmapped for R2, no
    2×|amount| == delta candidate for R3, no duplicate rows for R_DUP)
    and the scripted AI names the P&L account with the exact delta:
    the ONLY route to a pnl-placed receipt."""
    base_cents = draw(st.integers(10 ** 8, 10 ** 9))  # bank balance
    # Delta must STRICTLY clear the BALANCED tolerance band — max(1 RON,
    # 0.001% of assets) — which scales with the sheet AND is judged on
    # the POST-injection assets (the income case adds delta to the
    # asset side; the deep profile falsified the first floor exactly ON
    # the band: delta 1250 == 0.001% of 125,000,000-cent assets). Bound
    # the band by the largest possible post-injection sheet and add a
    # margin, while staying within the 0.1% reconcile gate. The band
    # also subsumes R1's cent window here.
    band_cents = max(100, (base_cents + base_cents // 2000) // 100_000) + 2
    delta_cents = band_cents + draw(st.integers(1, base_cents // 2000 - band_cents))
    pl_cents = 2 * delta_cents + draw(st.integers(1, 10 ** 6))  # 2×pl ≠ delta
    income = draw(st.booleans())
    return {"base": base_cents, "delta": delta_cents,
            "pl": pl_cents, "income": income}


@prop_settings(20, 200)
@given(case=pnl_cause_tb())
def test_p2b_pnl_placed_adjustment_is_additive_through_result_row(case):
    """The llm_proposed / pnl-placement lane (unreachable via the
    deterministic diagnoses, which never name class-6/7 accounts):
    the accepted delta moves ONLY the result row (by exactly the
    receipt amount, with the visible leaf note), reaches the P&L
    serving as `reconciliation_adjustment`, closes the served statement
    to exactly zero as RECONCILED-not-BALANCED, and the FactsGateway
    reads adjusted figures while raw_*() keeps the source cents."""
    base, delta, pl = case["base"], case["delta"], case["pl"]
    if case["income"]:
        # ΣD − ΣC = (base+delta) − (pl + base − pl) = +delta exactly.
        rows = [
            _mk_row("5121", "sf_d", base + delta),
            _mk_row("704", "sf_c", pl),
            _mk_row("1012", "sf_c", base - pl),
        ]
        target, amount_cents, result_row_id = "704", delta, "current_year_profit"
        detail = "pl_other_income"
    else:
        rows = [
            _mk_row("5121", "sf_d", base),
            _mk_row("609", "sf_d", pl),
            _mk_row("1012", "sf_c", base + pl + delta),
        ]
        target, amount_cents, result_row_id = "609", -delta, "current_year_loss"
        detail = "pl_other_expense"
    with quarantine("P2b_pnl_placed_adjustment_additive", _case_payload(case)):
        envelope = _envelope_for(rows, None)
        cbs = envelope["canonical_bs"]
        assert _cents(cbs["difference"]) == amount_cents
        assert cbs["status"] == "MINOR_DRIFT", cbs["status"]
        assert _reconcile.run_deterministic_diagnosis(cbs) is None

        with _ai_scripted(target, amount_cents):
            out = _reconcile.auto_reconcile_envelope(envelope)
        assert out["outcome"] == "accepted"
        assert out["origin"] == "llm_proposed"
        assert out["placement"] == "pnl"

        receipt = envelope["reconciliation"]
        assert receipt["placement_detail"] == detail
        assert receipt["target_row_id"] == result_row_id
        assert receipt["model"] == _reconcile.AI_MODEL
        assert receipt["prompt_version"] == _reconcile.PROMPT_VERSION

        served = _reconcile.served_canonical_bs(envelope)
        assert served["status"] == "RECONCILED"
        assert served["difference"] == 0.0
        _assert_not_balanced_family(served["status_presentation"])

        # Strictly additive: only the result row moved, by the delta.
        raw_by_id = {r["id"]: r for r in cbs["rows"]}
        moved = []
        for row in served["rows"]:
            raw_row = raw_by_id[row["id"]]
            if _cents(row["amount"]) != _cents(raw_row["amount"]):
                moved.append(row["id"])
                assert row["id"] == result_row_id
                assert _cents(row["amount"]) - _cents(raw_row["amount"]) == amount_cents
                assert _cents(row["reconciliation_delta"]) == amount_cents
                assert row["leaf_ids"] == raw_row["leaf_ids"]  # leaves untouched
        assert moved == [result_row_id]
        assert not any(r["id"] == _SYNTH_ROW_ID for r in served["rows"])

        # The P&L serving carries the visible line (REAL /api/period hook).
        statements = _serve_statements(envelope)
        line = statements["assembled_pl"]["reconciliation_adjustment"]
        assert line["placement"] == detail
        assert _cents(line["amount"]) == amount_cents
        assert line["synthetic"] is True

        # Gateway: adjusted vs raw.
        gw = FactsGateway.from_envelope(envelope)
        assert gw.net_result().amount_minor == \
            gw.raw_net_result().amount_minor + amount_cents
        assert gw.equity().amount_minor == \
            gw.raw_equity().amount_minor + amount_cents
        assert gw.difference().amount_minor == 0
        assert gw.raw_difference().amount_minor == amount_cents


# ═══════════════════════════════════════════════════════════════════════
# P3 — conservation (incl. unclassified value; AI-lane half in P8)
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(30, 400)
@given(case=gapped_tb())
def test_p3_conservation_of_source_value(case):
    """Nothing is dropped and nothing is invented:
      · partition equality — Σ(asset-section rows) − Σ(other rows) ==
        difference == totals.assets − totals.equity_plus_liabilities,
        and each side's section subtotals sum to its total;
      · balanced sources close to EXACTLY the injected delta (0 for
        kind zero) — the closing identity;
      · census — every nonzero-SF input account code appears in served
        leaf_ids ∪ unmapped ∪ excluded;
      · unmapped value RIDES THE TOTALS via the Unclassified rows
        (their cents equal the non-absorbed unmapped balances by side).
    The AI-lane low-confidence half of this property is asserted by
    P8 on generated lane envelopes (same partition equality there)."""
    rows, file_totals, delta = _materialize(case)
    with quarantine("P3_conservation_of_source_value", _case_payload(case, delta_cents=delta)):
        cbs = _assembled_for(rows, file_totals)["assembled_canonical_v1"]["canonical_bs"]

        asset_cents = sum(_cents(r["amount"]) for r in cbs["rows"]
                          if r["section"] in _ASSET_SECTIONS)
        el_cents = sum(_cents(r["amount"]) for r in cbs["rows"]
                       if r["section"] not in _ASSET_SECTIONS)
        totals = cbs["totals"]
        assert asset_cents == _cents(totals["assets"])
        assert el_cents == _cents(totals["equity_plus_liabilities"])
        assert asset_cents - el_cents == _cents(cbs["difference"])
        assert _cents(cbs["difference"]) == delta  # exact, in cents
        section_sums: Dict[str, int] = {}
        for section in cbs["sections"]:
            section_sums[section["id"]] = _cents(section["subtotal"])
        assert sum(v for k, v in section_sums.items() if k in _ASSET_SECTIONS) == asset_cents
        assert sum(v for k, v in section_sums.items() if k not in _ASSET_SECTIONS) == el_cents

        if delta == 0:
            assert cbs["status"] == "BALANCED"
            assert cbs["invariants"]["identity_holds"] is True

        # Census. Two tiers, discovered by this property's first run
        # (quarantined case: six `101` debit rows netting the whole
        # equity bucket to 0.00): presentation rows OMIT zero-net lines,
        # so a MAPPED code can legitimately be absent from leaf_ids when
        # its bucket nets to exactly zero — the value is still conserved
        # (partition equality + exact difference above prove it), and
        # the builder's own census invariant + D8 stay authoritative
        # for classified accounts. UNMAPPED and CLASS-8 codes have no
        # netting escape: their listing is the transparency contract.
        seen = set()
        for row in cbs["rows"]:
            seen.update(str(c) for c in (row.get("leaf_ids") or []))
        unmapped_listed = {str(u["code"]) for u in (cbs.get("unmapped") or [])}
        excluded_listed = {str(e["code"]) for e in (cbs.get("excluded") or [])}
        seen |= unmapped_listed | excluded_listed
        for r in rows:
            if not (_cents(r["sf_d"]) or _cents(r["sf_c"])):
                continue
            code = r["cont"]
            if code.startswith("8"):
                assert code in excluded_listed, "class-8 %s not excluded" % code
            elif coa.bucket_for(code) is None and code[0] not in ("6", "7"):
                assert code in unmapped_listed, "unmapped %s not listed" % code
            else:
                assert code in seen or coa.bucket_for(code) is not None, (
                    "account %s vanished without a mapping rule" % code
                )
        assert cbs["invariants"]["source_conservation"] is True
        assert not any(d["code"] == "D8_OMITTED" for d in cbs.get("diagnosis") or [])

        # Unclassified rows carry EXACTLY the non-absorbed unmapped value.
        unclassified = {r["id"]: r for r in cbs["rows"]
                        if str(r["id"]).startswith("unclassified_")}
        unmapped_d = unmapped_c = 0
        for entry in cbs.get("unmapped") or []:
            reason = str(entry.get("reason") or "")
            if "absorbed_in_result" in reason or "off_balance" in reason:
                continue
            unmapped_d += _cents(entry.get("sf_d"))
            unmapped_c += _cents(entry.get("sf_c"))
        got_d = _cents(unclassified.get("unclassified_debit", {}).get("amount"))
        got_c = _cents(unclassified.get("unclassified_credit", {}).get("amount"))
        assert got_d == unmapped_d
        assert got_c == unmapped_c
        if cbs.get("unmapped"):
            assert any(d["code"] == "D9_UNMAPPED_INCLUDED"
                       for d in cbs.get("diagnosis") or [])


# ═══════════════════════════════════════════════════════════════════════
# P4 — auto-reconcile triggers iff 0 < ratio <= 0.001
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(45, 500)
@given(case=gapped_tb())
def test_p4_trigger_iff_sub_threshold_ratio(case):
    """The automatic stage runs EXACTLY on 0 < |difference| /
    max(|assets|, |E+L|) <= 0.001 with a MINOR_DRIFT deterministic
    extraction: it then either accepts (receipt) or honestly
    needs-review (marker; AI consulted only when the deterministic
    diagnosis is inconclusive, and always blocked here). Zero → strict
    no-op. Above the gate → refused, nothing written, AI never entered.

    Documented refinement vs the one-line spec: a nonzero difference
    INSIDE the BALANCED tolerance band (|diff| <= max(1 RON, 0.001% of
    assets)) serves status BALANCED, and the stage no-ops on it — the
    ladder's tolerance is upstream of the reconcile gate."""
    rows, file_totals, delta = _materialize(case)
    with quarantine("P4_trigger_iff_sub_threshold_ratio",
                    _case_payload(case, delta_cents=delta)):
        with _ai_blocked() as ai_calls:
            envelope = _envelope_for(rows, file_totals)
            cbs = envelope["canonical_bs"]
            status = cbs["status"]
            diff_c = _cents(cbs["difference"])
            totals = cbs["totals"]
            denom = max(abs(_cents(totals["assets"])),
                        abs(_cents(totals["equity_plus_liabilities"])))
            in_gate = diff_c != 0 and denom > 0 and abs(diff_c) * 1000 <= denom
            deterministic_cause = (
                _reconcile.run_deterministic_diagnosis(cbs) is not None
                if in_gate and status == "MINOR_DRIFT" else None
            )

            out = _reconcile.auto_reconcile_envelope(envelope)
            served = _reconcile.served_canonical_bs(envelope)

            if diff_c == 0:
                assert case["kind"] == "zero" and status == "BALANCED"
                assert out["outcome"] == "balanced_noop"
                assert "reconciliation" not in envelope
                assert "reconciliation_auto" not in envelope
                assert ai_calls == []
                assert served["status"] == "BALANCED"
                assert served["needs_review"] is False
                assert served["reconcile_offer"] is False
            elif not in_gate:
                assert case["kind"] == "over"
                assert out["outcome"] in ("above_gate", "not_minor_drift")
                assert "reconciliation" not in envelope
                assert "reconciliation_auto" not in envelope
                assert ai_calls == []
                assert served["status"] == status  # untouched serving
                assert served["needs_review"] is False
                assert served["reconcile_offer"] is False
            else:
                assert case["kind"] == "sub"
                if status == "BALANCED":
                    # Tolerance band (documented refinement): no-op.
                    assert out["outcome"] == "balanced_noop"
                    assert "reconciliation" not in envelope
                    assert ai_calls == []
                elif status == "MINOR_DRIFT":
                    assert out["outcome"] in ("accepted", "needs_review")
                    if deterministic_cause:
                        assert out["outcome"] == "accepted"
                        assert ai_calls == []  # P9's quarantine, live here too
                    else:
                        assert out["outcome"] == "needs_review"
                        assert ai_calls == [1]  # one blocked attempt, no client
                    if out["outcome"] == "accepted":
                        receipt = envelope["reconciliation"]
                        assert receipt["origin"] == "deterministic"
                        assert receipt["applied_by"] == _reconcile.AUTO_APPLIED_BY
                        assert int(receipt["amount_cents"]) == diff_c
                        assert served["status"] == "RECONCILED"
                        assert served["difference"] == 0.0
                        assert "reconciliation_auto" not in envelope
                    else:
                        marker = envelope["reconciliation_auto"]
                        assert marker["outcome"] == "needs_review"
                        assert marker["content_hash"] == CONTENT_HASH
                        assert "reconciliation" not in envelope
                        assert served["status"] == "MINOR_DRIFT"
                        assert served["needs_review"] is True
                        assert served["reconcile_offer"] is True
                        assert served["status_presentation"]["micro_caption"] == "needs review"
                else:
                    # MATERIAL inside the gate is unreachable from a
                    # balanced base + <=0.1% injection; keep it honest.
                    assert out["outcome"] == "not_minor_drift"


# ═══════════════════════════════════════════════════════════════════════
# P5 — RECONCILED is never serialized as BALANCED, on any surface
# ═══════════════════════════════════════════════════════════════════════


@st.composite
def r2_reconcilable_tb(draw) -> Dict[str, Any]:
    """A TB whose auto-reconcile acceptance is GUARANTEED deterministic:
    balanced base with no pool unmapped codes, plus one reserved
    unmapped gap account whose balance IS the difference — R2 fires
    (or R1 for cent-sized deltas); either way no AI, always accepted."""
    case = draw(balanced_tb(allow_unmapped=False))
    case["kind"] = "sub"
    case["gap_scale"] = draw(st.integers(0, 10**6))
    case["gap_side"] = draw(st.sampled_from(("sf_d", "sf_c")))
    case["gap_code"] = (_UNMAPPED_GAP_DEBIT if case["gap_side"] == "sf_d"
                        else _UNMAPPED_GAP_CREDIT)
    return case


#: strict markers (RECONCILED surfaces — mirrors the I4 vitest/engine
#: check): no "balanc*"/"echilibr*" fragment at all. The relaxed form is
#: for arbitrary-status presentations, where MATERIAL_IMBALANCE's own
#: honest wording legitimately CONTAINS the fragment ("material
#: imbalance" / "dezechilibru") without being a balanced-family label —
#: the first P8 run tripped exactly that, so the relaxed markers match
#: only the affirmative words.
_BALANCED_FAMILY_STRICT = ("balanc", "echilibr")
_BALANCED_FAMILY_AFFIRMATIVE = ("balanced", "echilibrat")


def _assert_not_balanced_family(presentation: Dict[str, Any],
                                strict: bool = True) -> None:
    for key in ("display_key", "display_en", "display_ro"):
        low = str(presentation[key]).lower()
        if strict:
            for marker in _BALANCED_FAMILY_STRICT:
                assert marker not in low, (key, presentation[key])
        else:
            # Strip the honest negations first, then forbid what's left.
            scrubbed = low.replace("imbalance", "").replace("dezechilibr", "")
            for marker in _BALANCED_FAMILY_AFFIRMATIVE:
                assert marker not in scrubbed, (key, presentation[key])


@prop_settings(30, 300)
@given(case=r2_reconcilable_tb())
def test_p5_reconciled_never_serialized_as_balanced(case):
    """A RECONCILED serving never reads as BALANCED anywhere the engine
    serializes status: the API dict (machine status + the FE-consumed
    status_presentation), the persisted envelope (which keeps the honest
    MINOR_DRIFT source truth), the Excel-status string and the HTML
    string (both via the presenter-derived path — present_status is the
    ONE wording authority every surface calls; the FE half of the HTML/
    chip rendering is covered by the I4 vitest)."""
    rows, file_totals, delta = _materialize(case)
    with quarantine("P5_reconciled_never_serialized_as_balanced",
                    _case_payload(case, delta_cents=delta)):
        with _ai_blocked() as ai_calls:
            envelope = _envelope_for(rows, file_totals)
            raw_status = envelope["canonical_bs"]["status"]
            if raw_status == "BALANCED":
                # Cent-sized delta inside the ladder tolerance: nothing
                # to reconcile — P4 covers the no-op. Skip calmly.
                raise UnsatisfiedAssumption("delta inside BALANCED tolerance")
            assert _reconcile.run_deterministic_diagnosis(
                envelope["canonical_bs"]) is not None

            out = _reconcile.auto_reconcile_envelope(envelope)
            assert out["outcome"] == "accepted", out
            assert ai_calls == []

            # API dict + envelope.
            served = _reconcile.served_canonical_bs(envelope)
            assert served["status"] == "RECONCILED"
            assert served["status"] != "BALANCED"
            assert served["difference"] == 0.0
            assert envelope["canonical_bs"]["status"] == "MINOR_DRIFT"
            # The serialized API payload round-trips machine RECONCILED —
            # no serializer anywhere rewrites it into BALANCED.
            served_json = _dumps(served)
            assert json.loads(served_json)["status"] == "RECONCILED"
            assert '"status": "BALANCED"' not in served_json

            # FE-consumed field + every presenter surface (excel + html
            # are the strings those exports embed).
            stamped = served["status_presentation"]
            assert stamped == present_status(served, surface="api")
            assert stamped["machine"] == "RECONCILED"
            _assert_not_balanced_family(stamped)
            for surface in SURFACES:  # chip, html, excel, api
                presentation = present_status(served, surface=surface)
                assert presentation["machine"] == "RECONCILED"
                _assert_not_balanced_family(presentation)
                assert presentation["micro_caption"].startswith("auto-adjusted ")

            # The /api/period hook serves the same truth.
            statements = _serve_statements(envelope)
            cbs_served = statements["canonical_bs"]
            assert cbs_served["status"] == "RECONCILED"
            assert statements["assembled_bs"]["bs_balance_delta"] == 0.0
            _assert_not_balanced_family(cbs_served["status_presentation"])


# ═══════════════════════════════════════════════════════════════════════
# P6 — idempotence: pipeline(pipeline(x)) == pipeline(x)
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(15, 150)
@given(case=gapped_tb(kinds=("zero", "sub")))
def test_p6_pipeline_idempotent_on_repersist(case):
    """Re-persisting the SAME file through the REAL stage_persist and
    re-serving is byte-stable: the second serving equals the first, an
    accepted receipt is carried forward verbatim (not re-applied), and
    re-running the auto stage on an already-persisted envelope leaves
    it byte-identical. (On the needs-review branch the envelope-level
    marker carries a fresh attempt timestamp — the SERVED object, the
    only thing any client sees, is still byte-identical.)"""
    rows, file_totals, _delta = _materialize(case)
    with quarantine("P6_pipeline_idempotent_on_repersist", _case_payload(case)):
        with _ai_blocked():
            fake = _FakeAdminClient()
            first = _run_stage_persist(fake, _assembled_for(rows, file_totals))
            served_first = _reconcile.served_canonical_bs(first)

            second = _run_stage_persist(fake, _assembled_for(rows, file_totals))
            served_second = _reconcile.served_canonical_bs(second)

            assert _dumps(served_second) == _dumps(served_first)
            if "reconciliation" in first:
                # Carried forward, not re-applied: identical receipt,
                # no archived history entry.
                assert second["reconciliation"] == first["reconciliation"]
                assert "reconciliation_history" not in second

            # auto stage re-run on the persisted envelope: a no-op that
            # leaves the envelope byte-identical.
            before = _dumps(second)
            out = _reconcile.auto_reconcile_envelope(second)
            if "reconciliation" in second:
                assert out["outcome"] == "already_reconciled"
                assert _dumps(second) == before
            else:
                assert out["outcome"] in ("balanced_noop", "needs_review")
                if out["outcome"] == "balanced_noop":
                    assert _dumps(second) == before
                else:
                    # marker refreshed (new attempt timestamp) — served
                    # truth must not move.
                    assert _dumps(_reconcile.served_canonical_bs(second)) == \
                        _dumps(served_second)

            # Serve-twice purity on both persisted envelopes.
            assert _dumps(_reconcile.served_canonical_bs(first)) == _dumps(served_first)
            assert _dumps(_reconcile.served_canonical_bs(second)) == _dumps(served_second)


# ═══════════════════════════════════════════════════════════════════════
# P7 — permutation invariance
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(25, 300)
@given(case=gapped_tb())
def test_p7_row_order_never_changes_the_statement(case):
    """The canonical envelope is a pure function of the row MULTISET:
    the drawn shuffle, the fully sorted ordering and the reversed
    ordering produce byte-identical assembled envelopes (the builder
    orders its own output — verified as strict equality, no
    normalization needed)."""
    rows, file_totals, _delta = _materialize(case)
    with quarantine("P7_row_order_never_changes_the_statement", _case_payload(case)):
        baseline = _dumps(_assembled_for(list(rows), file_totals)["assembled_canonical_v1"])
        orderings = [
            sorted(rows, key=lambda r: _dumps(r)),
            list(reversed(rows)),
        ]
        for reordered in orderings:
            other = _dumps(_assembled_for(reordered, file_totals)["assembled_canonical_v1"])
            assert other == baseline


# ═══════════════════════════════════════════════════════════════════════
# P8 — AI-lane labels + needs_review array survive the serve path
# ═══════════════════════════════════════════════════════════════════════

# (code, label, line_id, side) — line_ids from the canonical vocabulary
# the classify stage validates against (the same ids the mocked-client
# suite uses); HU-flavored codes for realism.
_LANE_DEBIT_ROWS = (
    ("114", "Szellemi termékek", "intangibles_other"),
    ("123", "Épületek", "ppe_buildings"),
    ("211", "Anyagok", "inventory_raw_materials"),
    ("311", "Belföldi vevők", "ar_trade_gross"),
    ("381", "Pénztár", "cash_operating"),
    ("466", "Előzetesen felszámított áfa", "ar_tax_recoverable"),
)
_LANE_CREDIT_ROWS = (
    ("454", "Belföldi szállítók", "ap_trade"),
    ("467", "Fizetendő áfa", "ap_tax"),
    ("413", "Eredménytartalék", "retained_earnings_prior_years"),
)
_LANE_CONFIDENCES = (0.5, 0.62, 0.7, 0.84, 0.86, 0.9, 0.97)
_LANE_REVIEW_GATE = 0.85


@st.composite
def lane_case(draw) -> Dict[str, Any]:
    """A generated AI-lane document: drawn debit/credit accounts with
    HUF amounts, per-account confidences (some below the 0.85 gate →
    needs_review), balanced with share capital, plus an optional small
    source imbalance reflected honestly in the totals row."""
    debit = draw(st.lists(st.sampled_from(_LANE_DEBIT_ROWS),
                          min_size=1, max_size=len(_LANE_DEBIT_ROWS), unique=True))
    credit = draw(st.lists(st.sampled_from(_LANE_CREDIT_ROWS),
                           min_size=0, max_size=len(_LANE_CREDIT_ROWS), unique=True))
    rows = []
    for code, label, line_id in debit:
        rows.append({"code": code, "label": label, "line_id": line_id,
                     "side": "debit", "amount": draw(st.integers(1, 5 * 10**7)) * 100.0,
                     "confidence": draw(st.sampled_from(_LANE_CONFIDENCES))})
    for code, label, line_id in credit:
        rows.append({"code": code, "label": label, "line_id": line_id,
                     "side": "credit", "amount": draw(st.integers(1, 5 * 10**7)) * 100.0,
                     "confidence": draw(st.sampled_from(_LANE_CONFIDENCES))})
    net_debit = sum(r["amount"] for r in rows if r["side"] == "debit") - \
        sum(r["amount"] for r in rows if r["side"] == "credit")
    if net_debit > 0:
        rows.append({"code": "411", "label": "Jegyzett tőke", "line_id": "share_capital",
                     "side": "credit", "amount": net_debit,
                     "confidence": draw(st.sampled_from(_LANE_CONFIDENCES))})
    elif net_debit < 0:
        rows.append({"code": "384", "label": "Elszámolási betétszámla",
                     "line_id": "cash_operating", "side": "debit",
                     "amount": -net_debit,
                     "confidence": draw(st.sampled_from(_LANE_CONFIDENCES))})
    imbalanced = draw(st.booleans())
    gap = draw(st.integers(1, 10**5)) * 100.0 if imbalanced else 0.0
    return {"rows": draw(st.permutations(rows)), "gap": gap}


def _lane_model_jsons(case: Dict[str, Any]) -> Tuple[str, str, str]:
    """The three canned model responses (format → extract → classify)
    for the drawn document — the totals row honestly sums the extracted
    rows (plus the drawn source gap on the credit side)."""
    extract_rows = []
    for r in case["rows"]:
        extract_rows.append({
            "code": r["code"], "label": r["label"],
            "debit": r["amount"] if r["side"] == "debit" else None,
            "credit": r["amount"] if r["side"] == "credit" else None,
            "balance": None,
        })
    total_d = sum(r["amount"] for r in case["rows"] if r["side"] == "debit")
    total_c = sum(r["amount"] for r in case["rows"] if r["side"] == "credit")
    if case["gap"]:
        extract_rows.append({"code": "479", "label": "Egyéb kötelezettségek",
                             "debit": None, "credit": case["gap"], "balance": None})
        total_c += case["gap"]
    fmt = json.dumps({
        "layout": {"columns": ["Számla", "Megnevezés", "Tartozik", "Követel"],
                   "header_row": 1, "totals_row_index": len(extract_rows) + 2},
        "currency": "HUF", "scale": 1,
        "thousands_sep": " ", "decimal_sep": ",", "language": "hu",
    })
    extract = json.dumps({"rows": extract_rows,
                          "totals_row": {"debit": total_d, "credit": total_c}})
    assignments = [{"code": r["code"], "line_id": r["line_id"],
                    "confidence": r["confidence"], "rationale": "generated"}
                   for r in case["rows"]]
    if case["gap"]:
        assignments.append({"code": "479", "line_id": "ap_other",
                            "confidence": 0.9, "rationale": "generated"})
    classify = json.dumps({"assignments": assignments})
    return fmt, extract, classify


@prop_settings(20, 200)
@given(case=lane_case())
def test_p8_ai_lane_labels_and_needs_review_survive_serve(case):
    """Generated AI-lane envelopes (REAL run_ai_lane with the scripted
    fake client) keep their identity through the serve path: the llm
    extraction/classification labels survive, the status is NEVER
    BALANCED (the cap), the needs_review ARRAY (low-confidence mapping
    queue) survives serving verbatim — never retyped to this stage's
    boolean — the low-confidence VALUE rides the Unclassified rows
    inside the totals (the AI-lane half of P3), auto-reconcile stays
    out of llm extractions, and the FactsGateway reads the same cents
    the serving carries."""
    with quarantine("P8_ai_lane_labels_and_needs_review_survive_serve",
                    {"rows": case["rows"], "gap": case["gap"]}):
        fmt, extract, classify = _lane_model_jsons(case)
        client = _FakeAiClient([fmt, extract, classify])
        parsed = lane.run_ai_lane(
            doc={"id": "doc-hu-prop", "org_id": "org-prop",
                 "original_filename": "generated_hu_tb.csv"},
            file_bytes=_HU_BYTES, kind="csv",
            resolution={"jurisdiction": "HU", "source": "language", "confidence": 0.95},
            client_factory=lambda: client,
            admin_factory=lambda: _FakeAdminCtx([]),
        )
        envelope = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]
        envelope["provenance"] = {
            "source_document_id": "doc-hu-prop",
            "original_filename": "generated_hu_tb.csv",
            "content_hash": "sha256-lane-prop",
            "written_at": "2026-08-19T00:00:00+00:00",
        }
        cbs = envelope["canonical_bs"]

        # Permanent llm labels + the BALANCED cap.
        assert cbs["extraction"]["method"] == "llm"
        assert cbs["classification"]["method"] == "llm"
        assert cbs["status"] != "BALANCED"

        low_conf = sorted(r["code"] for r in case["rows"]
                          if r["confidence"] < _LANE_REVIEW_GATE)
        review = cbs.get("needs_review")
        if low_conf:
            assert isinstance(review, list)
            assert sorted(n["code"] for n in review) == low_conf
            for entry in review:
                assert entry["reason"] == "low_confidence_llm"
                assert entry["confidence"] < _LANE_REVIEW_GATE
        expected_review = copy.deepcopy(review)

        # Low-confidence value rides the Unclassified rows, IN totals:
        # partition equality over the served rows (P3, lane half).
        asset_cents = sum(_cents(r["amount"]) for r in cbs["rows"]
                          if r["section"] in _ASSET_SECTIONS)
        el_cents = sum(_cents(r["amount"]) for r in cbs["rows"]
                       if r["section"] not in _ASSET_SECTIONS)
        assert asset_cents == _cents(cbs["totals"]["assets"])
        assert el_cents == _cents(cbs["totals"]["equity_plus_liabilities"])
        assert asset_cents - el_cents == _cents(cbs["difference"])
        unclassified_leaves = set()
        for row in cbs["rows"]:
            if str(row["id"]).startswith("unclassified_"):
                unclassified_leaves.update(row["leaf_ids"])
        for code in low_conf:
            assert code in unclassified_leaves, (
                "low-confidence %s must ride an Unclassified row" % code
            )

        # Auto-reconcile never touches llm extractions (and never
        # constructs a client).
        with _ai_blocked() as ai_calls:
            out = _reconcile.auto_reconcile_envelope(envelope)
            assert out["outcome"] in ("balanced_noop", "not_minor_drift",
                                      "llm_extraction")
            assert "reconciliation" not in envelope
            assert ai_calls == []

        # Serve: the ARRAY survives verbatim; labels survive; the
        # additive guard sees no violation; presentation is honest.
        served = _reconcile.served_canonical_bs(envelope)
        assert served["needs_review"] == expected_review
        if low_conf:
            assert isinstance(served["needs_review"], list)
        assert served["extraction"]["method"] == "llm"
        assert served["classification"]["method"] == "llm"
        assert served["status"] != "BALANCED"
        assert additive_serve_violations(cbs, served) == []
        # Any-status presentation: never an AFFIRMATIVE balanced label
        # ("Material imbalance" honestly contains the fragment — relaxed).
        _assert_not_balanced_family(served["status_presentation"], strict=False)

        # Gateway reads the same served cents.
        gw = FactsGateway.from_envelope(envelope)
        assert gw is not None and gw.tier == FactsGateway.TIER_CANONICAL
        assert gw.total_assets().amount_minor == _cents(served["totals"]["assets"])
        assert gw.equity_plus_liabilities().amount_minor == \
            _cents(served["totals"]["equity_plus_liabilities"])
        assert gw.difference().amount_minor == _cents(served["difference"])


# ═══════════════════════════════════════════════════════════════════════
# P9 — model quarantine: deterministic diagnoses never construct a client
# ═══════════════════════════════════════════════════════════════════════


@prop_settings(30, 300)
@given(case=r2_reconcilable_tb(), kind=st.sampled_from(("diagnosable", "zero", "over")))
def test_p9_deterministic_diagnoses_never_reach_the_model(case, kind):
    """The generalized AI sentinel across the whole trigger domain:
      · a deterministically-diagnosable sub-threshold imbalance (R1/R2
        by construction) is accepted with the AI path NEVER entered;
      · balanced sources and above-gate drifts never enter it either.
    The sentinel records any `_ai_propose` entry and blocks the
    `anthropic` import — `calls == []` proves no client could have been
    constructed."""
    case = dict(case)
    if kind == "zero":
        case["kind"] = "zero"
    elif kind == "over":
        case["kind"] = "over"
        case["gap_code"] = "371" if case["gap_side"] == "sf_d" else "401"
    rows, file_totals, delta = _materialize(case)
    with quarantine("P9_deterministic_diagnoses_never_reach_the_model",
                    _case_payload(case, kind=kind, delta_cents=delta)):
        with _ai_blocked() as ai_calls:
            envelope = _envelope_for(rows, file_totals)
            cbs = envelope["canonical_bs"]
            if kind == "diagnosable":
                if cbs["status"] == "BALANCED":
                    raise UnsatisfiedAssumption("delta inside BALANCED tolerance")
                assert _reconcile.run_deterministic_diagnosis(cbs) is not None

            out = _reconcile.auto_reconcile_envelope(envelope)

            assert ai_calls == [], "the model was consulted on a %s case" % kind
            if kind == "diagnosable":
                assert out["outcome"] == "accepted"
                assert envelope["reconciliation"]["origin"] == "deterministic"
                assert _reconcile.served_canonical_bs(envelope)["status"] == "RECONCILED"
            elif kind == "zero":
                assert out["outcome"] == "balanced_noop"
            else:
                assert out["outcome"] in ("above_gate", "not_minor_drift")


# ═══════════════════════════════════════════════════════════════════════
# Pinned falsifications (found by THIS suite on 2026-08-19, then fixed)
# ═══════════════════════════════════════════════════════════════════════

# The first P3/P4/P5 runs quarantined a real engine bug (shrunken to
# 2-row TBs): every sign=−1 contra rule emitted the MAGNITUDE of
# whichever closing side was populated, so a balance closing on the
# WRONG side (169/129/269 credit-natural-contra ↔ 28x/29x/39x/49x/59x
# debit) inverted its contribution and broke the closing identity by
# exactly 2× the balance on a balanced source — silently
# (identity_holds=False, no diagnosis, status by tolerance ladder).
# Fixed in accounts_to_assemble_shape (tb_parser_v5): signed math for
# sign=−1 rules; natural-side balances stayed byte-identical (drift +
# determinism gates unchanged). Pinned here through the production path.

_WRONG_SIDE_CONTRA_CASES = [
    ("169", "sf_c"),   # contra-debt with a credit balance
    ("129", "sf_c"),   # profit distribution with a credit balance
    ("269", "sf_d"),   # contra financial-investment, debit balance
    ("2813", "sf_d"),  # accumulated depreciation, debit balance
    ("291", "sf_d"),   # impairment, debit balance
    ("391", "sf_d"),   # inventory allowance, debit balance
    ("491", "sf_d"),   # receivables allowance, debit balance
    ("591", "sf_d"),   # treasury allowance, debit balance
]


@pytest.mark.parametrize("code,side", _WRONG_SIDE_CONTRA_CASES,
                         ids=["%s_%s" % c for c in _WRONG_SIDE_CONTRA_CASES])
def test_pinned_wrong_side_contra_keeps_identity(code, side):
    counter = ("1012", "sf_c") if side == "sf_d" else ("5121", "sf_d")
    rows = [
        _mk_row(code, side, 100),
        _mk_row(counter[0], counter[1], 100),
    ]
    cbs = _assembled_for(rows, None)["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["difference"] == 0.0, (code, side, cbs["difference"])
    assert cbs["status"] == "BALANCED"
    assert cbs["invariants"]["identity_holds"] is True


def test_pinned_anchor_zero_sign_is_order_stable():
    """P7's second real finding (2026-08-19): `compute_source_anchor`
    accumulates extracted sums in float row order; two orderings of the
    same rows landed at ±1e-10 around an exact-zero delta and round()
    preserved the zero's sign — serializing "-0.0" vs "0.0", so the
    envelope was not a pure function of the row multiset. Fixed by
    `_round2z` (tb_parser_v5). The P7 property guards the general case;
    this pins the helper's contract."""
    assert json.dumps(tbp._round2z(-0.0)) == "0.0"
    assert json.dumps(tbp._round2z(-1e-12)) == "0.0"
    assert tbp._round2z(-4489.85) == -4489.85  # nonzero values untouched
    assert tbp._round2z(0.005) == round(0.005, 2)  # rounding semantics kept


def test_pinned_natural_side_contra_unchanged():
    """The other half of the v5 guarantee: natural-side contra math is
    byte-identical to the pre-fix vintage (the drift/determinism gates
    lock the golden fixtures; this pins the minimal algebra)."""
    rows = [
        _mk_row("212", "sf_d", 100_000),   # building 1,000.00
        _mk_row("2813", "sf_c", 40_000),   # accumulated depreciation 400.00
        _mk_row("1012", "sf_c", 60_000),   # equity 600.00
    ]
    cbs = _assembled_for(rows, None)["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["difference"] == 0.0
    assert cbs["status"] == "BALANCED"
    totals = cbs["totals"]
    assert _cents(totals["assets"]) == 60_000        # 1,000 − 400 net PP&E
    assert _cents(totals["equity"]) == 60_000


# ═══════════════════════════════════════════════════════════════════════
# Quarantine writer — unit coverage (redirected root, no corpus/ writes)
# ═══════════════════════════════════════════════════════════════════════


def test_quarantine_writer_captures_the_shrunken_input(tmp_path, monkeypatch):
    """Forces a deliberate hypothesis failure through the real hook with
    QUARANTINE_ROOT redirected to tmp_path: exactly one artifact dir
    survives (the shrinking churn is cleaned as it goes), and it holds
    the MINIMAL falsifying input with all four files."""
    module = sys.modules[__name__]
    monkeypatch.setattr(module, "QUARANTINE_ROOT", tmp_path / "quarantine")
    monkeypatch.setattr(module, "_LAST_QUARANTINE", {})

    @settings(max_examples=50, derandomize=True, deadline=None, database=None)
    @given(n=st.integers(min_value=0, max_value=10_000))
    def scratch_property(n):
        with quarantine("SCRATCH_writer_unit", {"n": n}):
            assert n < 5, "deliberate failure for the writer unit test"

    with pytest.raises(AssertionError):
        scratch_property()

    dirs = sorted((tmp_path / "quarantine").iterdir())
    assert len(dirs) == 1  # only the final (shrunken) example kept
    artifact = dirs[0]
    assert len(artifact.name) == 16 and all(
        c in "0123456789abcdef" for c in artifact.name
    )
    payload = json.loads((artifact / "input.json").read_text(encoding="utf-8"))
    assert payload == {"n": 5}  # hypothesis shrank to the minimal counterexample
    assert (artifact / "property").read_text(encoding="utf-8").strip() == \
        "SCRATCH_writer_unit"
    tb_text = (artifact / "traceback").read_text(encoding="utf-8")
    assert "deliberate failure for the writer unit test" in tb_text
    seed = json.loads((artifact / "seed").read_text(encoding="utf-8"))
    assert seed["profile"] in ("ci", "deep")
    assert seed["hypothesis"] == hypothesis.__version__


def test_quarantine_hook_passes_assume_misses_through(tmp_path, monkeypatch):
    """assume() misses are Hypothesis control flow, not failures — the
    hook must not write artifacts for them."""
    module = sys.modules[__name__]
    monkeypatch.setattr(module, "QUARANTINE_ROOT", tmp_path / "quarantine")
    monkeypatch.setattr(module, "_LAST_QUARANTINE", {})
    with pytest.raises(UnsatisfiedAssumption):
        with quarantine("SCRATCH_assume_unit", {"x": 1}):
            raise UnsatisfiedAssumption()
    assert not (tmp_path / "quarantine").exists()


# ═══════════════════════════════════════════════════════════════════════
# N5 — ABSENT is not ZERO, end to end through the Phase-1 IR
# ═══════════════════════════════════════════════════════════════════════

# The IR's invariant #1 (engine/ir/ledgerdoc.py): a null source value is
# ABSENT (None slot, key OMITTED on the wire), a stated 0 is ZERO Money
# (key present, amount_minor 0). Rows are generated with random
# ABSENT/ZERO/value patterns and adapted by the REAL llm_extract
# front-end (the one lane whose source schema states nullability per
# cell), then the distinction must survive serialize → deserialize →
# derive_legacy, on both the original and the round-tripped doc.
# Values are drawn as integer cents (floats only at the JSON boundary).

_N5_SIDE = st.one_of(
    st.none(),                                            # ABSENT
    st.just(0),                                           # stated ZERO
    st.integers(1, 10**11).map(lambda c: c / 100.0),      # stated value
)
_N5_BALANCE = st.one_of(
    st.none(),
    st.just(0),
    st.integers(1, 10**11).map(lambda c: c / 100.0),
    st.integers(1, 10**11).map(lambda c: -c / 100.0),     # credit-side balance
)


@st.composite
def n5_absent_zero_case(draw) -> Dict[str, Any]:
    n = draw(st.integers(1, 10))
    rows = [
        {
            "code": "%d" % (100 + i),
            "label": "acct %d" % i,
            "debit": draw(_N5_SIDE),
            "credit": draw(_N5_SIDE),
            "balance": draw(_N5_BALANCE),
        }
        for i in range(n)
    ]
    totals = draw(st.one_of(
        st.none(),
        st.fixed_dictionaries({"debit": _N5_SIDE, "credit": _N5_SIDE}),
    ))
    currency = draw(st.sampled_from(("RON", "HUF", "KWD")))
    return {"rows": rows, "totals_row": totals, "currency": currency}


@prop_settings(30, 300)
@given(case=n5_absent_zero_case())
def test_n5_absent_is_never_zero_through_ir_and_derive(case):
    """serialize / deserialize / derive_legacy all preserve ABSENT≠ZERO:
    a null source cell stays None at every hop (atom slot None, wire key
    omitted, derived field None) while a stated 0 stays a value at every
    hop (ZERO Money, wire amount_minor 0, derived 0.0) — across RON(2) /
    HUF(0) / KWD(3) scale tables."""
    from engine.frontends import derive_legacy, resolve_front_end
    from engine.ir import content_hash as _ir_hash
    from engine.ir import deserialize as _ir_load
    from engine.ir import serialize as _ir_dump

    with quarantine("N5_absent_is_never_zero", case):
        data = json.dumps(
            {"rows": case["rows"], "totals_row": case["totals_row"]}
        ).encode("utf-8")
        doc, _diags = resolve_front_end("llm_extract").parse(
            data, {"jurisdiction": "OTHER", "currency": case["currency"]}
        )
        assert len(doc.atoms) == len(case["rows"])

        # 1. Atom encoding (per the documented llm_extractor mapping).
        for row, atom in zip(case["rows"], doc.atoms):
            balance_only = (row["debit"] is None and row["credit"] is None
                            and row["balance"] is not None)
            if balance_only:
                if row["balance"] >= 0:
                    assert atom.closing_debit is not None
                    assert atom.closing_debit.is_zero() == (row["balance"] == 0)
                    assert atom.closing_credit is None
                else:
                    assert atom.closing_credit is not None
                    assert not atom.closing_credit.is_zero()
                    assert atom.closing_debit is None
            else:
                assert (atom.closing_debit is None) == (row["debit"] is None)
                assert (atom.closing_credit is None) == (row["credit"] is None)
                if row["debit"] is not None and row["debit"] == 0:
                    assert atom.closing_debit.is_zero()
                if row["credit"] is not None and row["credit"] == 0:
                    assert atom.closing_credit.is_zero()
            # This shape carries only the closing pair — the rest ABSENT.
            assert atom.opening_debit is None and atom.opening_credit is None
            assert atom.period_debit is None and atom.period_credit is None

        # 2. Wire shape: ABSENT keys OMITTED, ZERO present with minor 0.
        payload = _ir_dump(doc)
        for atom, wire in zip(doc.atoms, payload["atoms"]):
            for name in ("closing_debit", "closing_credit"):
                slot = getattr(atom, name)
                assert (name in wire) == (slot is not None)
                if slot is not None and slot.is_zero():
                    assert wire[name]["amount_minor"] == 0

        # 3. Round trip: byte-stable, hash-stable, distinction intact.
        blob = json.dumps(payload, sort_keys=True)
        round_tripped = _ir_load(payload)
        assert json.dumps(_ir_dump(round_tripped), sort_keys=True) == blob
        assert _ir_hash(round_tripped) == _ir_hash(doc)
        for atom, atom_rt in zip(doc.atoms, round_tripped.atoms):
            for name in ("closing_debit", "closing_credit"):
                assert getattr(atom_rt, name) == getattr(atom, name)
                assert (getattr(atom_rt, name) is None) == \
                    (getattr(atom, name) is None)

        # 4. derive_legacy — on the original AND the round-tripped doc:
        #    None stays None, 0 stays 0.0, values reproduce exactly.
        for view in (derive_legacy(doc), derive_legacy(round_tripped)):
            assert len(view.rows) == len(case["rows"])
            for row, derived in zip(case["rows"], view.rows):
                for key in ("debit", "credit", "balance"):
                    src, got = row[key], derived[key]
                    assert (got is None) == (src is None), (key, row, derived)
                    if src is not None:
                        assert got == float(src)
                        assert (got == 0.0) == (src == 0)
            totals = case["totals_row"]
            if totals is None:
                assert view.totals_debit is None
                assert view.totals_credit is None
            else:
                for src, got in ((totals["debit"], view.totals_debit),
                                 (totals["credit"], view.totals_credit)):
                    assert (got is None) == (src is None)
                    if src is not None:
                        assert got == float(src)
