"""METAMORPHIC suite (C2) — the M* invariant family.

Each M-property states a TRANSFORMATION of a source trial balance and
the EXACT relation the canonical builder's output must satisfy between
the base run and the transformed run — no oracle values, only algebra:

  M1  scale ×10^k       every statement figure scales by exactly 10^k
                        (k in 1..3), integer cent domain respected; the
                        reconcile-gate ratio |difference| / max(assets,
                        E+L) is scale-invariant (asserted as an exact
                        Fraction, no float tolerance).
  M2  merge             two BALANCED docs concatenated (totals row
                        re-summed) stay BALANCED; every total and every
                        section subtotal is additive to the cent.
  M3  mirror            swapping every debit/credit column flips the
                        sign of `difference` EXACTLY (difference ==
                        ΣSF_D − ΣSF_C by the closing identity, and the
                        mirror swaps the sums). The naive full
                        assets<->E+L side exchange is NOT universally
                        true in RAS semantics — a credit-balance
                        building (212) is a CONTRA-ASSET (negative on
                        the asset side), not a liability; verified
                        empirically and asserted in the scoped M3b
                        below, where every account IS a bifunctional
                        with a side-flip rule and the exchange is exact.
  M4  scale-neutrality  the same minor-unit values presented at
                        different Money scales (2 vs 3, mixed) produce
                        byte-identical statements / identical
                        classification layers after normalization.
  M5  label immutability scrambling account labels (the corpus
                        anonymizer's own transform) changes NO number
                        anywhere in the assembled envelope
                        (numbers-only comparator).
  M6  row order (P7+)   any permutation of source rows produces a
                        byte-identical canonical_bs AND assembled
                        envelope — not just equal totals.

Inputs: the deterministic RO corpus cases (parsed once per session,
transformed at the parsed-row level, re-run through the SAME
TrialBalanceParseResult → attach_closing_result → assemble_parsed_tb
composition the identity property suite uses — the production
stage_extract/stage_map code objects), PLUS generated inputs reusing
tests/engine/test_identity_property.py's seeded generator (balanced and
deliberately-imbalanced families).

A failing M-property is potentially a REAL BUG — investigate before
weakening (this suite family caught a real parser bug before).
"""

from __future__ import annotations

import json
import random
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
SCRIPTS = REPO / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.country_packs.ro_romania import trial_balance_parser as tbp  # noqa: E402
from engine.ir import AccountAtom, DocHeader, LedgerDoc, Money, Provenance, SourceRef  # noqa: E402
from engine.packs.runtime import active_pack  # noqa: E402
from engine.passes.classify import classify  # noqa: E402

import anonymize_tb  # noqa: E402  (scripts/ — the corpus anonymizer)
import test_identity_property as idp  # noqa: E402  (the shared generator)

CORPUS = REPO / "corpus"

# Deterministic RO corpus cases usable at the parsed-row level (the two
# mocked-LLM lanes and the HU lane transform model responses, not rows).
_CORPUS_CASE_IDS = [
    "saga_10_col", "saga_10_col_agras", "saga_10_col_carniprod",
    "saga_10_col_realestate", "saga_10_col_retail", "saga_compact_6_col",
    "csv", "generic_4_col", "exact_zero", "rounding_004pct",
    "imbalance_03pct", "contra_sign_flip", "dup_totals_row",
    "unmapped_equals_delta", "pdf_positional",
]
_GEN_INDICES = (0, 3, 7, 9, 42, 105, 133, 199)   # balanced generator seeds
_IMB_INDICES = (10_000, 10_007)                   # imbalanced-family seeds

INPUT_IDS = (
    ["corpus:%s" % c for c in _CORPUS_CASE_IDS]
    + ["gen:%d" % i for i in _GEN_INDICES]
    + ["imb:%d" % i for i in _IMB_INDICES]
)

_ROW_FIELDS = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c")
_TOTALS_KEYS = ("assets", "equity", "liabilities", "equity_plus_liabilities",
                "current_assets", "current_liabilities")


def _cents(value: Any) -> int:
    return int(round(float(value or 0) * 100))


# ── input loading + the production composition ─────────────────────────


def _load_input(pack, input_id: str) -> Tuple[List[Dict], Optional[Dict], Dict]:
    """(rows, file_totals, extraction) for one metamorphic input."""
    kind, _, name = input_id.partition(":")
    if kind == "corpus":
        case_dir = CORPUS / name
        meta = yaml.safe_load((case_dir / "meta.yaml").read_text(encoding="utf-8"))
        input_path = sorted(case_dir.glob("input.*"))[0]
        content = input_path.read_bytes()
        if str(meta["expected_parser"]) == "csv":
            tb = pack.parse_trial_balance_csv(content, input_path.name)
        else:
            tb = pack.parse_trial_balance(content, input_path.name)
        rows = [dict(r) for r in tb]
        for r in rows:  # normalize row shape: every column key present
            for f in _ROW_FIELDS:
                r.setdefault(f, 0.0)
        # Transformed runs re-derive the anchor from the rows themselves
        # (file_totals=None) so base and transform are judged identically.
        return rows, None, dict(getattr(tb, "extraction", {}) or {})
    if kind == "gen":
        rows, file_totals, _ = idp._generate_tb(int(name))
        return rows, file_totals, _synth_extraction()
    if kind == "imb":
        # The imbalanced family, mirrored from the identity suite's
        # injection: a one-sided row the file's own totals faithfully
        # reflect (D1 — broken source, honest extraction).
        idx = int(name)
        rows, _ft, _hu = idp._generate_tb(idx)
        rng = random.Random(idp.FIXED_SEED ^ (0xD1 + idx))
        gross = sum(int(round(r["sf_d"] * 100)) for r in rows)
        delta_cents = max(200, gross // 2000, rng.randint(200, 5_000_000))
        if idx % 2 == 0:
            rows.append(idp._row("371", sf_d=delta_cents / 100.0))
        else:
            rows.append(idp._row("401", sf_c=delta_cents / 100.0))
        return rows, idp._file_totals(rows), _synth_extraction()
    raise AssertionError("unknown input id %r" % input_id)


def _synth_extraction() -> Dict[str, Any]:
    return {
        "method": "deterministic",
        "parser_version": tbp.PARSER_VERSION,
        "source_format": "saga_10_col",
        "number_locale": "anglo",
        "sheet": "TB_metamorphic",
        "header_row_index": 0,
    }


def _build(pack, rows: List[Dict], file_totals: Optional[Dict],
           extraction: Dict[str, Any]) -> Dict[str, Any]:
    """The REAL parse-shape → assemble composition (the same code
    objects run_deterministic_tb and stage_extract/stage_map compose,
    incl. the parse-time closing_result anchor enrichment). Returns the
    full assembled_canonical_v1 envelope."""
    rows = [dict(r) for r in rows]  # never let assemble alias the cache
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction=dict(extraction),
        source_anchor=tbp.compute_source_anchor(
            rows,
            file_totals=file_totals,
            pairs_present=None,
            totals_row_index=None if file_totals is None else 0,
        ),
    )
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Metamorphic TB", period_label="MM",
    )
    return assembled["assembled_canonical_v1"]


@pytest.fixture(scope="session")
def mm(pack):
    """Session cache: input_id -> (rows, file_totals, extraction) and
    input_id -> base envelope (each input parsed and base-built once)."""
    inputs: Dict[str, Tuple[List[Dict], Optional[Dict], Dict]] = {}
    bases: Dict[str, Dict[str, Any]] = {}

    class _MM:
        def input(self, input_id: str):
            if input_id not in inputs:
                inputs[input_id] = _load_input(pack, input_id)
            return inputs[input_id]

        def base(self, input_id: str) -> Dict[str, Any]:
            if input_id not in bases:
                rows, ft, ex = self.input(input_id)
                bases[input_id] = _build(pack, rows, ft, ex)
            return bases[input_id]

        def build(self, rows, file_totals, extraction) -> Dict[str, Any]:
            return _build(pack, rows, file_totals, extraction)

    return _MM()


# ── row / totals transforms ────────────────────────────────────────────


def _scale_rows(rows: List[Dict], k: int) -> List[Dict]:
    """Multiply every amount by 10^k, in the exact integer cent domain
    (never float-multiply the serialized value)."""
    out = []
    for r in rows:
        r2 = dict(r)
        for f in _ROW_FIELDS:
            r2[f] = (_cents(r.get(f)) * (10 ** k)) / 100.0
        out.append(r2)
    return out


def _scale_totals(file_totals: Optional[Dict], k: int) -> Optional[Dict]:
    if file_totals is None:
        return None
    return {key: (_cents(v) * (10 ** k)) / 100.0 for key, v in file_totals.items()}


def _mirror_rows(rows: List[Dict]) -> List[Dict]:
    out = []
    for r in rows:
        r2 = dict(r)
        for d_field, c_field in (("si_d", "si_c"), ("r_d", "r_c"),
                                 ("st_d", "st_c"), ("sf_d", "sf_c")):
            r2[d_field], r2[c_field] = r.get(c_field, 0.0), r.get(d_field, 0.0)
        out.append(r2)
    return out


def _mirror_totals(file_totals: Optional[Dict]) -> Optional[Dict]:
    if file_totals is None:
        return None
    out = dict(file_totals)
    for d_key, c_key in (("initial_debit", "initial_credit"),
                         ("period_debit", "period_credit"),
                         ("cumulative_debit", "cumulative_credit"),
                         ("final_debit", "final_credit")):
        if d_key in out or c_key in out:
            out[d_key], out[c_key] = file_totals.get(c_key), file_totals.get(d_key)
    return out


def _gate_ratio(cbs: Dict[str, Any]) -> Optional[Fraction]:
    """The auto-reconcile gate ratio |difference| / max(assets, E+L),
    as an EXACT rational over integer cents (None when undefined)."""
    assets = _cents(cbs["totals"]["assets"])
    el = _cents(cbs["totals"]["equity_plus_liabilities"])
    denom = max(assets, el)
    if denom == 0:
        return None
    return Fraction(abs(_cents(cbs["difference"])), denom)


def _numbers_only(obj: Any) -> Any:
    """Numbers-only projection: strings -> None, structure preserved;
    lists of code-keyed dicts are re-sorted content-wise so a label-only
    sort-key change (code ties broken by name) cannot misalign the
    comparison."""
    if isinstance(obj, dict):
        return {k: _numbers_only(v) for k, v in obj.items()}
    if isinstance(obj, list):
        items = [_numbers_only(v) for v in obj]
        if items and all(isinstance(v, dict) and "code" in v for v in items):
            items.sort(key=lambda d: json.dumps(d, sort_keys=True, default=str))
        return items
    if isinstance(obj, str):
        return None
    return obj


def _dump(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, default=str)


# ── M1: scale ×10^k ────────────────────────────────────────────────────


@pytest.mark.parametrize("k", (1, 2, 3))
@pytest.mark.parametrize("input_id", INPUT_IDS)
def test_m1_scale_by_power_of_ten(mm, input_id, k):
    rows, ft, ex = mm.input(input_id)
    base = mm.base(input_id)["canonical_bs"]
    scaled = mm.build(_scale_rows(rows, k), _scale_totals(ft, k), ex)["canonical_bs"]
    mult = 10 ** k

    # Rows: same ids in the same order; every amount scales exactly and
    # stays an integer multiple of 10^k cents (integer domain respected).
    assert [r["id"] for r in scaled["rows"]] == [r["id"] for r in base["rows"]], (
        "%s k=%d: row id sequence changed under pure scaling" % (input_id, k)
    )
    for rb, rs in zip(base["rows"], scaled["rows"]):
        cb, cs = _cents(rb["amount"]), _cents(rs["amount"])
        assert cs == cb * mult, (
            "%s k=%d row %s: %d cents != %d * %d" % (input_id, k, rb["id"], cs, cb, mult)
        )
        assert cs % mult == 0
        assert rs["leaf_ids"] == rb["leaf_ids"]
        assert rs["account_codes"] == rb["account_codes"]

    # Sections and totals scale exactly.
    for sb, ss in zip(base["sections"], scaled["sections"]):
        assert ss["id"] == sb["id"]
        assert _cents(ss["subtotal"]) == _cents(sb["subtotal"]) * mult, (
            "%s k=%d section %s" % (input_id, k, sb["id"])
        )
    for key in _TOTALS_KEYS:
        assert _cents(scaled["totals"][key]) == _cents(base["totals"][key]) * mult, (
            "%s k=%d totals.%s" % (input_id, k, key)
        )
    assert _cents(scaled["difference"]) == _cents(base["difference"]) * mult, (
        "%s k=%d difference" % (input_id, k)
    )

    # The reconcile gate ratio is scale-invariant BY CONSTRUCTION —
    # exact rational equality, not float tolerance.
    assert _gate_ratio(scaled) == _gate_ratio(base), (
        "%s k=%d: gate ratio not scale-invariant" % (input_id, k)
    )

    # Status: the tolerance ladder is ratio-based except the absolute
    # 1-RON BALANCED floor, so the band is scale-invariant everywhere
    # but the sub-1-RON nonzero-difference corner (a documented property
    # of the contract's floor, not a bug).
    if not (0 < abs(_cents(base["difference"])) <= 100):
        assert scaled["status"] == base["status"], (
            "%s k=%d: status %s -> %s" % (input_id, k, base["status"], scaled["status"])
        )
    if _cents(base["difference"]) == 0:
        assert scaled["status"] == base["status"] == "BALANCED" or \
            base["status"] != "BALANCED"  # non-BALANCED zero-diff: anchor/llm caps carry over
        assert scaled["status"] == base["status"]


# ── M2: merge of two balanced docs ─────────────────────────────────────

_M2_PAIRS = [
    ("gen:0", "gen:3"), ("gen:7", "gen:42"), ("gen:105", "gen:133"),
    ("gen:9", "gen:199"), ("corpus:saga_10_col", "gen:0"),
    ("corpus:exact_zero", "gen:105"),
]


@pytest.mark.parametrize("left_id,right_id", _M2_PAIRS,
                         ids=["%s+%s" % p for p in _M2_PAIRS])
def test_m2_merge_balanced_docs(mm, left_id, right_id):
    rows_a, _fa, ex = mm.input(left_id)
    rows_b, _fb, _exb = mm.input(right_id)
    a = mm.base(left_id)["canonical_bs"]
    b = mm.base(right_id)["canonical_bs"]
    # Precondition of the property: both operands are BALANCED.
    assert a["status"] == "BALANCED" and b["status"] == "BALANCED", (
        "M2 precondition: %s=%s %s=%s" % (left_id, a["status"], right_id, b["status"])
    )

    merged_rows = [dict(r) for r in rows_a] + [dict(r) for r in rows_b]
    merged = mm.build(
        merged_rows, idp._file_totals(merged_rows), ex
    )["canonical_bs"]

    assert merged["status"] == "BALANCED", merged["status"]
    assert _cents(merged["difference"]) == 0
    for key in _TOTALS_KEYS:
        assert _cents(merged["totals"][key]) == (
            _cents(a["totals"][key]) + _cents(b["totals"][key])
        ), "totals.%s not additive to the cent" % key
    sec_a = {s["id"]: _cents(s["subtotal"]) for s in a["sections"]}
    sec_b = {s["id"]: _cents(s["subtotal"]) for s in b["sections"]}
    for s in merged["sections"]:
        assert _cents(s["subtotal"]) == sec_a[s["id"]] + sec_b[s["id"]], (
            "section %s not additive" % s["id"]
        )


# ── M3: mirror — the sign of difference flips exactly ──────────────────


@pytest.mark.parametrize("input_id", INPUT_IDS)
def test_m3_mirror_difference_sign_flips(mm, input_id):
    rows, ft, ex = mm.input(input_id)
    base = mm.base(input_id)["canonical_bs"]
    mirror = mm.build(_mirror_rows(rows), _mirror_totals(ft), ex)["canonical_bs"]

    # difference == ΣSF_D − ΣSF_C by the closing identity; the mirror
    # swaps the sums, so the sign flips EXACTLY — on balanced, drifting
    # and materially-imbalanced sources alike.
    assert _cents(mirror["difference"]) == -_cents(base["difference"]), (
        "%s: mirror difference %r != -(%r)"
        % (input_id, mirror["difference"], base["difference"])
    )
    # Stated on the totals as well (the builder's difference must be the
    # totals' difference on both sides — no hidden plug).
    for cbs in (base, mirror):
        assert _cents(cbs["difference"]) == (
            _cents(cbs["totals"]["assets"])
            - _cents(cbs["totals"]["equity_plus_liabilities"])
        )
    if _cents(base["difference"]) == 0 and base["status"] == "BALANCED":
        assert mirror["status"] == "BALANCED", (
            "%s: balanced source lost BALANCED under mirror: %s"
            % (input_id, mirror["status"])
        )


def test_m3b_mirror_bifunctional_side_exchange(mm):
    """Scoped strong form: when EVERY account is a bifunctional with a
    side-flip rule (both directions economically defined), the mirror
    exchanges the sides exactly: assets(mirror) == E+L(base) and
    E+L(mirror) == assets(base). Built deliberately IMBALANCED so the
    exchange is not just the balanced identity comparing to itself."""
    rows = [
        idp._row("5121", sf_d=30.0),   # cash            -> mirror: ST bank debt
        idp._row("4111", sf_d=20.0),   # AR              -> mirror: customer advances
        idp._row("401", sf_c=35.0),    # AP              -> mirror: supplier advances (asset)
        idp._row("419", sf_c=15.0),    # customer adv.   -> mirror: refund due (asset)
        idp._row("461", sf_d=10.0),    # sundry debtor   -> mirror: sundry creditor
    ]
    base = mm.build(rows, None, _synth_extraction())["canonical_bs"]
    mirror = mm.build(_mirror_rows(rows), None, _synth_extraction())["canonical_bs"]

    assert _cents(base["totals"]["assets"]) == 6000
    assert _cents(base["totals"]["equity_plus_liabilities"]) == 5000
    assert _cents(mirror["totals"]["assets"]) == _cents(
        base["totals"]["equity_plus_liabilities"]
    )
    assert _cents(mirror["totals"]["equity_plus_liabilities"]) == _cents(
        base["totals"]["assets"]
    )
    assert _cents(mirror["difference"]) == -_cents(base["difference"]) != 0


# ── M4: currency-scale neutrality (via the IR Money layer) ─────────────

_M4_GEN = ("gen:0", "gen:42", "gen:199")


@pytest.mark.parametrize("input_id", _M4_GEN)
def test_m4_scale_neutrality_statements(mm, input_id):
    """The same minor-unit values, rendered through Money at scale 2 and
    at scale 3 (an extra trailing zero of precision), normalize to
    byte-identical statements."""
    rows, ft, ex = mm.input(input_id)

    def _rerender(scale: int) -> List[Dict]:
        out = []
        for r in rows:
            r2 = dict(r)
            for f in _ROW_FIELDS:
                cents = _cents(r.get(f))
                minor = cents * (10 ** (scale - 2))
                r2[f] = float(Money.from_minor("RON", minor, scale).to_decimal_str())
            out.append(r2)
        return out

    at_scale2 = mm.build(_rerender(2), ft, ex)
    at_scale3 = mm.build(_rerender(3), ft, ex)
    assert _dump(at_scale2) == _dump(at_scale3), (
        "%s: scale-2 vs scale-3 presentation produced different envelopes"
        % input_id
    )


def test_m4_scale_neutrality_classify():
    """Classification is scale-neutral: the same values carried at
    scale 2 vs mixed scales (×10 at scale 3 on alternating slots) yield
    the SAME assignments, sides and flips — exercising the classify
    pass's exact integer rescale normalization."""
    ro = active_pack("RO")
    values = [
        ("5121", 3000, 0), ("4111", 0, 2500), ("401", 0, 3500),
        ("212", 100000, 0), ("419", 700, 0), ("491", 0, 900),
        ("999", 0, 0),  # no rule -> UNCLASSIFIED marker on both docs
    ]

    def _doc(mixed: bool) -> LedgerDoc:
        atoms = []
        for i, (code, d_cents, c_cents) in enumerate(values):
            if mixed and i % 2 == 1:
                debit = Money.from_minor("RON", d_cents * 10, 3)
                credit = Money.from_minor("RON", c_cents * 10, 3)
            else:
                debit = Money.from_minor("RON", d_cents, 2)
                credit = Money.from_minor("RON", c_cents, 2)
            atoms.append(AccountAtom(
                atom_id="a%d" % i, account_code=code, label="Cont %s" % code,
                provenance=Provenance.mechanical(SourceRef.cell("S", i, 0)),
                closing_debit=debit, closing_credit=credit,
            ))
        return LedgerDoc(
            header=DocHeader(jurisdiction="RO", currency="RON"),
            atoms=tuple(atoms),
        )

    layer_flat = classify(_doc(mixed=False), ro)
    layer_mixed = classify(_doc(mixed=True), ro)
    assert layer_flat == layer_mixed, (
        "classification diverged between scale presentations of the "
        "same minor-unit values"
    )


# ── M5: label immutability ─────────────────────────────────────────────


@pytest.mark.parametrize("input_id", INPUT_IDS)
def test_m5_label_scramble_changes_no_number(mm, input_id):
    rows, ft, ex = mm.input(input_id)
    base = mm.base(input_id)
    seed = anonymize_tb.content_seed(b"metamorphic-M5")
    scrambled_rows = []
    for r in rows:
        r2 = dict(r)
        r2["nume_cont"] = anonymize_tb.scramble_text(
            seed, str(r.get("nume_cont") or "")
        )
        scrambled_rows.append(r2)
    scrambled = mm.build(scrambled_rows, ft, ex)
    assert _dump(_numbers_only(base)) == _dump(_numbers_only(scrambled)), (
        "%s: scrambling labels changed a NUMBER in the assembled envelope"
        % input_id
    )


# ── M6: row-order permutation (extends P7) ─────────────────────────────


@pytest.mark.parametrize("perm_seed", (1, 2))
@pytest.mark.parametrize("input_id", INPUT_IDS)
def test_m6_row_order_permutation(mm, input_id, perm_seed):
    rows, ft, ex = mm.input(input_id)
    base = mm.base(input_id)
    permuted = [dict(r) for r in rows]
    random.Random(0xBEEF + perm_seed).shuffle(permuted)
    out = mm.build(permuted, ft, ex)
    # The FULL canonical builder output — rows, leaf_ids, diagnosis,
    # transparency blocks — must be byte-identical, not just the totals.
    assert _dump(out["canonical_bs"]) == _dump(base["canonical_bs"]), (
        "%s perm %d: canonical_bs changed under row permutation"
        % (input_id, perm_seed)
    )
    assert _dump(out) == _dump(base), (
        "%s perm %d: assembled envelope changed under row permutation"
        % (input_id, perm_seed)
    )
