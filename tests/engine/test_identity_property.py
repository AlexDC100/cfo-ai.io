"""CLOSING-IDENTITY property suite (the future-proof guarantee).

For ANY source trial balance whose SF column pair balances (D == C after
netting off-balance class-8 single-entry rows), `canonical_bs.difference`
must be EXACTLY 0.00 and status BALANCED — by algebraic construction,
not tolerance. The double-entry identity: when every value-bearing
account contributes its signed closing balance to exactly one side of
the statement, assets − (equity + liabilities) == ΣSF_D − ΣSF_C == 0.

A deterministic-seeded generator (`random.Random(FIXED_SEED)`, no
hypothesis dependency) produces ~200 random balanced TBs — 20-400
accounts sampled across classes 1-7 including contra families
(28x/29x/39x/49x/59x on their natural credit side; 129/169 debit),
bifunctionals on BOTH sides (4111/401/409/419/455/461/462/473/418 and
5121/5124-credit overdrafts), the full TVA family (4423/4424/4426/4427
and 4428 by side), 117 on both sides, price differentials 348/378 on
either side, class-8 single-entry memo rows, deliberately UNMAPPED
codes (the agras-413 / carniprod-4282 leak class), and pre-closing
(open 6/7 with movement noise), post-closing (121 carries the result)
and mixed closing states — each per-TB adjusted in integer cents so
ΣSF_D == ΣSF_C exactly.

Every TB runs through the REAL parser-shape + assemble composition
(`accounts_to_assemble_shape` → `RomaniaPack.assemble_parsed_tb`, the
same code object `run_deterministic_tb` and the pipeline's
stage_extract/stage_map compose — including the parse-time
`closing_result` anchor enrichment).

Also: 20 deliberately imbalanced TBs (a missing counter-entry baked
into the rows AND the file's own totals row) asserting
difference == the injected imbalance EXACTLY and D1 present.
"""

from __future__ import annotations

import random
from typing import Dict, List, Optional, Tuple

import pytest

from engine.country_packs.ro_romania import trial_balance_parser as tbp

FIXED_SEED = 0x1DE4717  # "IDENTITY" — never change without a re-baseline note
N_BALANCED = 200
N_IMBALANCED = 20

# ── Account pools: (code, natural sf side) ─────────────────────────────
# Credit-natural balance-sheet accounts (equity / liabilities).
_BS_CREDIT = [
    "1012", "104", "105", "1061", "1068", "1171", "1175", "151",
    "161", "1621", "166", "167", "168", "401", "403", "404", "408",
    "419", "421", "4281", "423", "431", "436", "4411", "441", "4423",
    "4427", "442", "444", "446", "448", "456", "457", "462", "472",
    "475", "478", "5191", "509",
]
# Debit-natural balance-sheet accounts (assets).
_BS_DEBIT = [
    "211", "212", "2131", "214", "215", "231", "261", "263", "265",
    "2671", "301", "302", "331", "345", "351", "371", "381", "4091",
    "4092", "4093", "4111", "4118", "418", "425", "4382", "4424",
    "4426", "4482", "451", "452", "455", "461", "471", "473", "481",
    "5121", "5124", "5311", "532", "117.1", "1174",
]
# Contra families — natural credit side, reduce assets (28x/29x/39x/49x/59x).
_CONTRA_CREDIT = ["2801", "2811", "2813", "291", "391", "397", "491", "496", "591"]
# Contra families — natural debit side (129 profit distribution, 169 contra-debt).
_CONTRA_DEBIT = ["129", "169"]
# Bifunctionals exercised on the side OPPOSITE their natural one.
_BI_FLIPPED = [
    ("4111", "sf_c"),  # customer credit balance → advance received
    ("401", "sf_d"),   # supplier debit balance → advance/overpayment
    ("409", "sf_c"),
    ("419", "sf_d"),
    ("455", "sf_c"),
    ("461", "sf_c"),
    ("462", "sf_d"),
    ("473", "sf_c"),
    ("418", "sf_c"),
    ("4424", "sf_c"),
    ("4426", "sf_c"),
    ("4428", "sf_d"),  # deferred input VAT — asset side
    ("4428", "sf_c"),  # deferred output VAT — liability side
    ("5121", "sf_c"),  # RON overdraft → ST bank debt
    ("5124", "sf_c"),  # FX overdraft
]
# Price differentials — either side, signed math in the parser.
_PRICE_DIFF = ["348", "378"]
# Codes with NO mapping rule — the agras/carniprod leak class; their
# balances MUST still be in the totals (Unclassified rows).
_UNMAPPED = [("413", "sf_d"), ("4282", "sf_d"), ("438", "sf_c"), ("482", "sf_c")]
# P&L pools.
_PL_EXPENSE = [
    "601", "602", "605", "607", "611", "612", "622", "628", "635",
    "641", "645", "665", "666", "6811", "691",
]
_PL_REVENUE = [
    "701", "704", "706", "707", "708", "711", "722", "758", "765",
    "766", "767", "781",
]
# Class 8 — off-balance single-entry memo rows (excluded from both the
# statement and the balance judgment).
_CLASS8 = ["8033", "8036", "8051", "891", "892"]


def _row(code: str, **fields: float) -> Dict[str, float]:
    row = {"cont": code, "nume_cont": f"Cont {code}",
           "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
           "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    row.update(fields)
    return row


def _amount_cents(rng: random.Random) -> int:
    """1 cent .. 5M RON, log-ish mix of magnitudes."""
    scale = rng.choice((100, 10_000, 1_000_000, 100_000_000, 500_000_000))
    return rng.randint(1, scale)


def _generate_tb(case_index: int) -> Tuple[List[Dict], Optional[Dict], bool]:
    """One balanced TB: returns (rows, file_totals|None, has_unmapped).
    All sf columns are exact integer cents rendered as floats; the TB is
    adjusted so ΣSF_D == ΣSF_C EXACTLY (in cents) over non-class-8 rows.
    """
    rng = random.Random(FIXED_SEED + case_index)
    variant = case_index % 3          # 0 post-closing, 1 pre-closing, 2 mixed
    closing_only = case_index % 10 == 9  # no movement columns anywhere
    if closing_only:
        variant = 1
    n_target = rng.randint(20, 400)

    rows: List[Dict] = []

    def _add_bs(code: str, side: str, cents: int) -> None:
        rows.append(_row(code, **{side: cents / 100.0}))

    # ── Balance-sheet accounts ─────────────────────────────────────────
    n_bs = max(10, int(n_target * 0.6))
    for _ in range(n_bs):
        bucket_pick = rng.random()
        if bucket_pick < 0.42:
            _add_bs(rng.choice(_BS_DEBIT), "sf_d", _amount_cents(rng))
        elif bucket_pick < 0.80:
            _add_bs(rng.choice(_BS_CREDIT), "sf_c", _amount_cents(rng))
        elif bucket_pick < 0.87:
            _add_bs(rng.choice(_CONTRA_CREDIT), "sf_c", _amount_cents(rng))
        elif bucket_pick < 0.90:
            _add_bs(rng.choice(_CONTRA_DEBIT), "sf_d", _amount_cents(rng))
        elif bucket_pick < 0.96:
            code, side = rng.choice(_BI_FLIPPED)
            _add_bs(code, side, _amount_cents(rng))
        else:
            code = rng.choice(_PRICE_DIFF)
            _add_bs(code, rng.choice(("sf_d", "sf_c")), _amount_cents(rng))

    has_unmapped = rng.random() < 0.5
    if has_unmapped:
        for code, side in rng.sample(_UNMAPPED, rng.randint(1, len(_UNMAPPED))):
            _add_bs(code, side, _amount_cents(rng))

    # ── P&L + 121 per closing state ────────────────────────────────────
    n_pl = max(4, int(n_target * 0.3))
    for _ in range(n_pl):
        expense = rng.random() < 0.55
        code = rng.choice(_PL_EXPENSE) if expense else rng.choice(_PL_REVENUE)
        x = _amount_cents(rng)
        noise = rng.randint(0, x // 3) if rng.random() < 0.4 else 0
        if variant == 0:
            # Post-closing: movements on both sides (closure mirrors the
            # accumulation), SF zero.
            side_d, side_c = (x + noise, x + noise)
            sf_d = sf_c = 0
        else:
            # Pre-closing/mixed: SF open; movements = SF + reversal noise
            # (immunity check: the identity must not read movements).
            if expense:
                side_d, side_c, sf_d, sf_c = x + noise, noise, x, 0
            else:
                side_d, side_c, sf_d, sf_c = noise, x + noise, 0, x
        if closing_only:
            side_d = side_c = 0
        rows.append(_row(code, st_d=side_d / 100.0, st_c=side_c / 100.0,
                         sf_d=sf_d / 100.0, sf_c=sf_c / 100.0))
    # Contra-revenue 709 — debit balance pre-closing.
    if variant != 0 and rng.random() < 0.5:
        x = _amount_cents(rng)
        rows.append(_row("709", st_d=0.0 if closing_only else x / 100.0,
                         sf_d=x / 100.0))

    if variant in (0, 2):
        # 121 carries the closed result — either sign.
        x = _amount_cents(rng)
        side = "sf_c" if rng.random() < 0.7 else "sf_d"
        r = _row("121", **{side: x / 100.0})
        if not closing_only:
            r["st_d"], r["st_c"] = x / 100.0, x / 100.0
        rows.append(r)

    # ── Class 8 single-entry memo rows (should never affect anything) ──
    for _ in range(rng.randint(0, 3)):
        rows.append(_row(rng.choice(_CLASS8),
                         **{rng.choice(("sf_d", "sf_c")): _amount_cents(rng) / 100.0}))
    if rng.random() < 0.3:
        rows.append(_row("581"))  # transit, zero balance (the normal state)

    rng.shuffle(rows)

    # ── Balance the TB exactly, in cents, over non-class-8 rows ────────
    imb = _sf_imbalance_cents(rows)
    if imb > 0:
        rows.append(_row("1012", sf_c=imb / 100.0))
    elif imb < 0:
        rows.append(_row("5121", sf_d=-imb / 100.0))
    assert _sf_imbalance_cents(rows) == 0

    # Real TBs obey double-entry on EVERY column pair: the cumulative
    # (sume totale) pair must balance too, or the file's own totals row
    # would honestly judge the source imbalanced. Balance it with a
    # counter-movement on a dedicated settlement row (sf zero — no
    # effect on the closing identity; the anchor pair judgment is what
    # this satisfies).
    st_imb = sum(
        int(round(r["st_d"] * 100)) - int(round(r["st_c"] * 100))
        for r in rows if not r["cont"].startswith("8")
    )
    if st_imb > 0:
        rows.append(_row("401", st_c=st_imb / 100.0))
    elif st_imb < 0:
        rows.append(_row("4111", st_d=-st_imb / 100.0))

    file_totals = _file_totals(rows) if case_index % 2 == 0 else None
    return rows, file_totals, has_unmapped


def _sf_imbalance_cents(rows: List[Dict]) -> int:
    d = sum(int(round(r["sf_d"] * 100)) for r in rows if not r["cont"].startswith("8"))
    c = sum(int(round(r["sf_c"] * 100)) for r in rows if not r["cont"].startswith("8"))
    return d - c


def _file_totals(rows: List[Dict]) -> Dict[str, float]:
    """The file's own totals row — sums over ALL rows (class 8 included,
    like real SAGA prints), in exact cents."""
    keys = (("initial_debit", "si_d"), ("initial_credit", "si_c"),
            ("period_debit", "r_d"), ("period_credit", "r_c"),
            ("cumulative_debit", "st_d"), ("cumulative_credit", "st_c"),
            ("final_debit", "sf_d"), ("final_credit", "sf_c"))
    out: Dict[str, float] = {}
    for name, field in keys:
        out[name] = sum(int(round(r[field] * 100)) for r in rows) / 100.0
    return out


def _run(pack, rows: List[Dict], file_totals: Optional[Dict]) -> Dict:
    """The REAL parser-shape + assemble path: TrialBalanceParseResult
    with a genuinely computed anchor, parse-time closing_result
    enrichment, then the production post-parse composition."""
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
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Property TB", period_label="PROP",
    )
    return assembled["assembled_canonical_v1"]["canonical_bs"]


# ── ~200 balanced TBs: difference EXACTLY 0.00, status BALANCED ────────

@pytest.mark.parametrize("case_index", range(N_BALANCED))
def test_balanced_tb_difference_exactly_zero(pack, case_index):
    rows, file_totals, has_unmapped = _generate_tb(case_index)
    cbs = _run(pack, rows, file_totals)

    assert cbs["difference"] == 0.0, (
        f"case {case_index}: difference {cbs['difference']!r} != 0.0 "
        f"(status {cbs['status']}, rows {len(rows)})"
    )
    assert cbs["status"] == "BALANCED", f"case {case_index}: {cbs['status']}"
    inv = cbs["invariants"]
    assert inv["identity_holds"] is True
    assert inv["result_basis"] == "sf_closing_column"
    assert inv["assets_eq_row_sum"] is True
    assert inv["el_eq_row_sum"] is True
    # Anchor faithfulness: when the generator printed a totals row it
    # must MATCH (class-8 inclusion resolved via the off-balance
    # fallback), and the file must judge as balanced.
    anchor = cbs["source_anchor"]
    if file_totals is not None:
        assert anchor["anchor_status"] == "MATCHED"
        assert anchor["source_balanced"] is True
    # Unmapped value is IN the totals and loudly visible: an Unclassified
    # row exists, the accounts stay listed, D9 flags the inclusion.
    uncls_rows = [r for r in cbs["rows"] if r["id"].startswith("unclassified_")]
    if has_unmapped:
        assert uncls_rows, f"case {case_index}: unmapped sampled but no Unclassified row"
        assert any(d["code"] == "D9_UNMAPPED_INCLUDED"
                   for d in cbs.get("diagnosis") or [])
        unmapped_codes = {u["code"] for u in cbs["unmapped"]}
        for r in uncls_rows:
            for code in r["leaf_ids"]:
                assert code in unmapped_codes
    # No class 6/7 account may sit on any row other than the derived
    # current-year result line (which documents them via leaf_ids).
    for row in cbs["rows"]:
        if row["id"] in ("current_year_profit", "current_year_loss"):
            continue
        for code in row.get("leaf_ids") or []:
            assert not code.startswith(("6", "7")), (
                f"case {case_index}: P&L account {code} on BS row {row['id']}"
            )


# ── 20 deliberately imbalanced TBs: difference == injected, D1 fires ───

@pytest.mark.parametrize("case_index", range(N_IMBALANCED))
def test_imbalanced_tb_difference_equals_injected_gap(pack, case_index):
    rows, _ft, _hu = _generate_tb(10_000 + case_index)
    rng = random.Random(FIXED_SEED ^ (0xD1 + case_index))
    # Inject a missing counter-entry: one side only, big enough that the
    # tolerance ladder can never absorb it (≥ 2 RON and ≥ 0.05% of the
    # gross SF magnitude).
    gross = sum(int(round(r["sf_d"] * 100)) for r in rows)
    delta_cents = max(200, gross // 2000, rng.randint(200, 5_000_000))
    sign = 1 if case_index % 2 == 0 else -1
    if sign > 0:
        rows.append(_row("371", sf_d=delta_cents / 100.0))
    else:
        rows.append(_row("401", sf_c=delta_cents / 100.0))
    # The file's own totals row faithfully reflects the imbalanced rows —
    # extraction is honest, the SOURCE is broken (D1, never D0).
    cbs = _run(pack, rows, _file_totals(rows))

    expected = (sign * delta_cents) / 100.0
    assert cbs["difference"] == expected, (
        f"case {case_index}: difference {cbs['difference']!r} != injected {expected!r}"
    )
    assert cbs["status"] != "BALANCED"
    anchor = cbs["source_anchor"]
    assert anchor["anchor_status"] == "MATCHED"      # faithful extraction
    assert anchor["source_balanced"] is False        # broken source
    codes = [d["code"] for d in cbs.get("diagnosis") or []]
    assert "D1_SOURCE_IMBALANCED" in codes, f"case {case_index}: {codes}"
    # The identity invariant is vacuous on an imbalanced source — it must
    # not claim a violation.
    assert cbs["invariants"]["identity_holds"] is True


# ── Adversarial-verifier probes (2026-08-15), pinned as regressions ────
# Three edge cases found by kill-testing the first identity implementation.
# Each was a LOUD failure (identity_holds=False + nonzero difference), but
# the closing-identity promise is exact zero on ANY balanced source — so
# each is now fixed and pinned here through the same production path.

def test_unmapped_class7_account_not_double_counted(pack):
    """Balanced pre-closing pair 5121/799: the unmapped 799 is absorbed by
    the result line (attach_closing_result sums ALL class 6/7 rows) and
    must NOT also land in the Unclassified rows. Verifier probe was
    difference −100.00 MATERIAL; must be exactly 0.00 BALANCED."""
    rows = [
        _row("5121", sf_d=100.0),
        _row("799", sf_c=100.0),  # no rule in the legacy table
    ]
    cbs = _run(pack, rows, None)
    assert cbs["difference"] == 0.0, cbs["difference"]
    assert cbs["status"] == "BALANCED", cbs["status"]
    # Still visible: 799 stays in the unmapped transparency list, marked
    # as absorbed by the result line rather than routed to Unclassified.
    reasons = {u["code"]: u["reason"] for u in cbs["unmapped"]}
    assert "799" in reasons and "absorbed_in_result" in reasons["799"], reasons


def test_transit_581_nonzero_closing_keeps_identity(pack):
    """581 with a nonzero closing balance is real money in transit: it is
    included in the partition by balance side. Verifier probe was
    difference −50 with 581 excluded from the statement but included in
    the source-balance judgment; must be exactly 0.00 BALANCED."""
    rows = [
        _row("581", sf_d=50.0),
        _row("1012", sf_c=50.0),
    ]
    cbs = _run(pack, rows, None)
    assert cbs["difference"] == 0.0, cbs["difference"]
    assert cbs["status"] == "BALANCED", cbs["status"]
    listed = {u["code"] for u in cbs["unmapped"]}
    assert any(c.startswith("581") for c in listed), listed


def test_class9_pair_excluded_from_statement(pack):
    """A self-balancing class-9 pair (management accounting, off-balance
    like class 8) must not inflate either side of the statement. Verifier
    probe: assets 80 vs true 10 with identity intact — class 9 now stays
    out of the statement entirely."""
    rows = [
        _row("5121", sf_d=10.0),
        _row("1012", sf_c=10.0),
        _row("901", sf_d=70.0),
        _row("902", sf_c=70.0),
    ]
    cbs = _run(pack, rows, None)
    assert cbs["difference"] == 0.0, cbs["difference"]
    assert cbs["status"] == "BALANCED", cbs["status"]
    assert cbs["totals"]["assets"] == 10.0, cbs["totals"]["assets"]
    reasons = {u["code"]: u.get("reason", "") for u in cbs["unmapped"]}
    for code in ("901", "902"):
        if code in reasons:
            assert "off_balance" in reasons[code], reasons
