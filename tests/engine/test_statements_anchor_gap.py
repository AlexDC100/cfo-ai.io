"""statements-anchor-gap — the assembled P&L reproduces account 121, and a
mirrored contra row enters its statement bucket as the reduction it is
(plan_contract_v2 5.1 / 28.3 B4a; owner ruling 2026-09-18: the 609/709
double count is a P0; battery gate ``statements-anchor-gap``).

THE DEFECT
==========
Saga exports that close class 6/7 into account 121 print each P&L row's
cumulative value on BOTH turnover sides. For an account whose nature is
contra to the bucket it lands in (609 supplier discounts in operating
expenses, 709 customer reductions in revenue) exporters disagree on the
sign: the frozen Scandia golden writes the reductions negative, the retail,
agras and carniprod exports write them positive. The deterministic parser
took the printed sign as the entry's direction, so on the positive-writing
books every supplier discount was ADDED to operating cost and every customer
reduction ADDED to revenue: retail opex 16,640,349.00 instead of
14,105,136.48, and a reconstruction that missed account 121 by 2,043,254.64.

WHAT THIS GATE CHECKS (real parse -> assemble, no double)
=========================================================
1. THE ANCHOR GAP. On every corpus book, the Scandia regression baseline
   (src/engine/country_packs/ro_romania/fixtures/regression_baselines/
   scandia_fy2025.json, aggregates only) and any local book named in
   PLAN_LOCAL_XLSX, |account 121 - reconstruction| is printed and must be
   within a floor rendered from packs/ro/statements_anchor.yaml and the
   book itself (TC-10): the pack's cent tolerance plus the turnover of the
   book's rows under the pack's hidden-net prefixes (711/712, whose year
   net a mirrored exporter hides behind gross turnover on both sides). On
   a book with no such rows the floor is one cent. The books examined
   (TC-13) and the contra convention each decided (TC-12) are printed.
2. Account 121 as the witness of the repair: on the retail corpus book the
   reconstruction reproduces the filed account-121 profit to the cent.
3. Every mirrored contra row of every corpus xlsx enters its bucket with the
   sign of a reduction under the document's convention: the shaped amount is
   the printed value negated on an entry-magnitude document, and the printed
   value on a natural-signed one.
4. Metamorphic: rewriting an entry-magnitude document into the
   natural-signed convention (negating its mirrored contra rows' turnover
   columns, nothing else) leaves revenue, cost of sales, operating cost and
   the reconstruction byte-identical, and the reverse rewrite of the
   natural-signed golden does the same. The two exporter conventions of one
   ledger are one statement.
5. The contra nature is read from the canonical schema's declared sign
   meaning, never from a hand-kept account list (781 is expense_negative
   but lands in a credit-natural bucket, so it is never flipped).

WHAT IT REDS ON AFTER THE REPAIR (TC-11)
----------------------------------------
A class-6/7 row entering its bucket with the wrong sign on a book whose
production-variation turnover cannot hide it (the retail 121 witness reds
with the gap printed); a mirrored contra row entering with the exporter's
sign on an entry-magnitude document (the metamorphic pair diverges); a
natural-signed document flipped (the golden's 709 rows red); a contra
account read from a hand-kept list (the 781 check reds); a floor written as
a code literal (the pack is the only source; a missing key reds); a scope
with no document of either convention, or with no book carrying account
121 (TC-3).

IT CANNOT SEE: a wrong sign on a book whose 711 turnover is larger than the
error (agras and carniprod under the parent parser: gaps of -6.57M and
-4.41M inside floors of 192M and 88M — the retail book, with no 711, is the
one that decides); a document whose contra rows net positive only because
stornos outweigh the reductions they reverse (the decision is per document,
by the net; no corpus book is shaped that way); non-mirrored rows (the
one-side SAGA path is unchanged and covered by the corpus replay); the served
statements of periods persisted before this repair (they need re-processing;
the owner's count is asked for in forecast_blast_radius.md under 609).
"""

from __future__ import annotations

import copy
import json
import os
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
import yaml

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.country_packs.ro_romania import chart_of_accounts as coa

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"
PACK = REPO / "packs" / "ro" / "statements_anchor.yaml"
BASELINE = (REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures"
            / "regression_baselines" / "scandia_fy2025.json")

#: The parser before B4a has no contra_convention attribute; the gate names
#: that state instead of inventing a convention for it.
_PREDATES = {"convention": "not_decided (parser predates B4a)",
             "mirrored_contra_rows": 0, "mirrored_contra_sum": 0.0}


def _pack() -> Dict[str, Any]:
    data = yaml.safe_load(PACK.read_text(encoding="utf-8"))
    assert data.get("schema_version") == "statements_anchor/1", data.get("schema_version")
    gap = data["anchor_gap"]
    tol = Decimal(str(gap["cent_tolerance"]))
    prefixes = tuple(str(p) for p in gap["hidden_net_prefixes"])
    assert tol > 0 and prefixes, gap
    return {"cent_tolerance": tol, "hidden_net_prefixes": prefixes,
            "sentence_within": gap["sentence_within"],
            "sentence_beyond": gap["sentence_beyond"]}


#: Every corpus case the deterministic xlsx lane parses. Discovered, never
#: typed: a case added to the corpus joins the scope.
def _xlsx_cases() -> List[str]:
    out = []
    for case in sorted(p.name for p in CORPUS.iterdir() if p.is_dir()):
        if (CORPUS / case / "input.xlsx").is_file() and \
                (CORPUS / case / "meta.yaml").is_file():
            out.append(case)
    return out


def _local_books() -> Dict[str, Path]:
    """Opt-in: PLAN_LOCAL_XLSX=<path>[,<path>...] (client books, never
    committed; aggregates are printed for the owner only)."""
    raw = os.environ.get("PLAN_LOCAL_XLSX", "").strip()
    out = {}  # type: Dict[str, Path]
    for item in (p.strip() for p in raw.split(",") if p.strip()):
        path = Path(item).expanduser()
        if path.is_file():
            out["local " + path.name] = path
    return out


_CACHE = {}  # type: Dict[str, Any]


def _parse_bytes(key: str, content: bytes, filename: str):
    if key not in _CACHE:
        pack = get_pack("RO")
        try:
            rows = pack.parse_trial_balance(content, filename)
        except Exception as exc:  # noqa: BLE001 — a non-TB case is out of scope
            _CACHE[key] = exc
        else:
            _CACHE[key] = rows
    value = _CACHE[key]
    return None if isinstance(value, Exception) else value


def _parse(case: str):
    return _parse_bytes(case, (CORPUS / case / "input.xlsx").read_bytes(), "input.xlsx")


def _assemble(rows) -> Tuple[Any, Dict[str, Any]]:
    pack = get_pack("RO")
    _tb, shaped, assembled = pack.assemble_parsed_tb(
        rows, company_name="anchor", period_label="anchor")
    return shaped, assembled["statements"]["assembled_pl"]


def _convention(shaped) -> Dict[str, Any]:
    return getattr(shaped, "contra_convention", _PREDATES)


def _hidden_turnover(rows, prefixes) -> Decimal:
    """The turnover of the rows whose year net a mirrored exporter hides:
    the larger cumulative side (the closing sides when no cumulative block
    exists), summed over the pack's prefixes."""
    total = Decimal("0")
    for r in rows:
        code = (r.get("cont") or "").strip()
        if not code.startswith(prefixes):
            continue
        st = max(abs(Decimal(str(r.get("st_d") or 0))), abs(Decimal(str(r.get("st_c") or 0))))
        if st == 0:
            st = max(abs(Decimal(str(r.get("sf_d") or 0))), abs(Decimal(str(r.get("sf_c") or 0))))
        total += st
    return total.quantize(Decimal("0.01"))


def _gap_and_floor_live(rows, pl, pack) -> Tuple[Optional[Decimal], Decimal, Decimal]:
    """(gap, floor, hidden turnover) for a parsed book. gap None: no 121."""
    anchor = tbp.compute_statutory_net_profit_anchor(rows)
    if anchor is None:
        return None, pack["cent_tolerance"], Decimal("0")
    gap = Decimal(str(pl["net_income_unexplained_vs_121"])).quantize(Decimal("0.01"))
    hidden = _hidden_turnover(rows, pack["hidden_net_prefixes"])
    return gap, pack["cent_tolerance"] + hidden, hidden


def _gap_and_floor_baseline(pack) -> Tuple[Decimal, Decimal, Decimal, Dict[str, Any]]:
    """The committed Scandia FY2025 regression baseline carries aggregates
    only (no rows): 121 from its p121 block, the reconstruction as
    net_income_operational + capitalized own work, the hidden turnover as
    its inventory_variation_memo (the memo IS the 711 turnover on a
    mirrored book)."""
    data = json.loads(BASELINE.read_text(encoding="utf-8"))
    pl = data["assembled"]["statements"]["assembled_pl"]
    inv = data["assembled"]["assembled_canonical_v1"]["canonical_bs"]["invariants"]["p121_cross_check"]
    p121 = Decimal(str(inv["p121"]))
    reconstruction = (Decimal(str(pl["net_income_operational"]))
                      + Decimal(str(pl.get("capitalized_own_work_memo") or 0)))
    gap = (p121 - reconstruction).quantize(Decimal("0.01"))
    hidden = Decimal(str(pl["inventory_variation_memo"])).quantize(Decimal("0.01"))
    return gap, pack["cent_tolerance"] + hidden, hidden, {
        "company": data["_meta"].get("company"), "p121": p121,
        "reconstruction": reconstruction}


def test_a_the_reconstruction_reaches_account_121_within_the_pack_floor(capsys):
    pack = _pack()
    lines = []  # type: List[str]
    reds = []  # type: List[str]
    examined = 0
    with_121 = 0
    conventions = {}  # type: Dict[str, str]

    def judge(name: str, gap: Optional[Decimal], floor: Decimal,
              hidden: Decimal, convention: str) -> None:
        nonlocal examined, with_121
        examined += 1
        conventions[name] = convention
        if gap is None:
            lines.append("  %-40s no account 121 in this book (not judged); convention %s"
                         % (name, convention))
            return
        with_121 += 1
        ok = abs(gap) <= floor
        lines.append("  %-40s |121 - reconstruction| = %s; floor %s (cent tolerance %s + "
                     "hidden %s turnover %s); %s; convention %s"
                     % (name, gap, floor, pack["cent_tolerance"],
                        "/".join(pack["hidden_net_prefixes"]), hidden,
                        "within" if ok else "BEYOND", convention))
        if not ok:
            reds.append("%s: |121 - reconstruction| = %s exceeds the floor %s: %s"
                        % (name, gap, floor, pack["sentence_beyond"]))

    for case in _xlsx_cases():
        rows = _parse(case)
        if rows is None:
            lines.append("  %-40s does not parse as a trial balance (out of scope)" % case)
            continue
        shaped, pl = _assemble(rows)
        gap, floor, hidden = _gap_and_floor_live(rows, pl, pack)
        judge("corpus " + case, gap, floor, hidden, _convention(shaped)["convention"])

    gap, floor, hidden, meta = _gap_and_floor_baseline(pack)
    judge("regression baseline scandia_fy2025 (%s)" % meta["company"], gap, floor,
          hidden, "aggregates only (no rows to decide from)")

    for name, path in _local_books().items():
        rows = _parse_bytes(name, path.read_bytes(), path.name)
        if rows is None:
            lines.append("  %-40s does not parse (out of scope)" % name)
            continue
        shaped, pl = _assemble(rows)
        gap, floor, hidden = _gap_and_floor_live(rows, pl, pack)
        judge(name, gap, floor, hidden, _convention(shaped)["convention"])

    with capsys.disabled():
        print("\nSCOPE statements-anchor-gap (plan/2 B4a, contract 5.1): books examined %d "
              "(%d carry account 121), floor from %s#anchor_gap"
              % (examined, with_121, PACK.relative_to(REPO)))
        print("\n".join(lines))
    assert examined > 0 and with_121 > 0, "no book with account 121 examined (TC-3)"
    assert not reds, "\n".join(reds)


def test_b_retail_reproduces_account_121_to_the_cent():
    rows = _parse("saga_10_col_retail")
    assert rows is not None, "the retail corpus book no longer parses"
    shaped, pl = _assemble(rows)
    anchor = tbp.compute_statutory_net_profit_anchor(rows)
    assert anchor is not None
    assert round(pl["net_income_reconstructed"] - anchor, 2) == 0, (
        "retail: the build-up reaches %.2f, account 121 filed %.2f"
        % (pl["net_income_reconstructed"], anchor))
    assert round(pl["net_income_unexplained_vs_121"], 2) == 0, pl
    assert _convention(shaped)["convention"] == tbp.CONTRA_ENTRY_MAGNITUDE, \
        _convention(shaped)


_CREDIT_POS_PL = {"revenue", "otherIncome", "inventoryVariationMemo",
                  "financialIncome", "financial_income", "interest_income",
                  "fx_gain", "capitalizedOwnWork"}
_DEBIT_POS_PL = {"cogs", "operatingExpenses", "opex_third_party",
                 "depreciation", "interestExpense", "interest_expense",
                 "financialExpense", "fx_loss", "taxExpense"}


def _mirrored_contra(rows) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        code = (r.get("cont") or "").strip()
        st_d = float(r.get("st_d") or 0)
        st_c = float(r.get("st_c") or 0)
        if not code or not tbp._is_mirrored(st_d, st_c):
            continue
        rule = coa.bucket_for(code)
        if rule and tbp._pl_contra_to_bucket(
                code, rule.bucket, credit_pos_pl=_CREDIT_POS_PL,
                debit_pos_pl=_DEBIT_POS_PL):
            out.append(r)
    return out


def _rewrite(rows, codes):
    """The same ledger in the other exporter convention: the mirrored contra
    rows' turnover columns negated, every other cell untouched."""
    out = copy.deepcopy(rows)
    for r in out:
        if (r.get("cont") or "").strip() in codes:
            for col in ("r_d", "r_c", "st_d", "st_c"):
                if r.get(col) not in (None, ""):
                    r[col] = -float(r[col])
    return out


PL_KEYS = ("revenue", "cogs", "opex_excluding_cogs_and_da",
           "net_income_reconstructed")


def test_c_781_is_expense_negative_but_never_contra_to_its_bucket():
    rule = coa.bucket_for("7812")
    assert rule is not None
    assert not tbp._pl_contra_to_bucket(
        "7812", rule.bucket, credit_pos_pl=_CREDIT_POS_PL,
        debit_pos_pl=_DEBIT_POS_PL)
    for code in ("609", "709"):
        rule = coa.bucket_for(code)
        assert tbp._pl_contra_to_bucket(
            code, rule.bucket, credit_pos_pl=_CREDIT_POS_PL,
            debit_pos_pl=_DEBIT_POS_PL), code


def test_d_every_mirrored_contra_row_enters_as_a_reduction_and_both_conventions_agree(capsys):
    decided = {}  # type: Dict[str, Dict[str, Any]]
    rows_checked = 0
    metamorphic = 0
    reds = []  # type: List[str]
    for case in _xlsx_cases():
        rows = _parse(case)
        if rows is None:
            continue
        shaped, pl = _assemble(rows)
        convention = _convention(shaped)
        decided[case] = convention
        contra = _mirrored_contra(rows)
        if not contra:
            continue
        amount_of = dict((a["code"], a["amount"]) for a in shaped)
        for r in contra:
            code = r["cont"].strip()
            printed = float(r["st_c"])
            want = (-printed if convention["convention"]
                    == tbp.CONTRA_ENTRY_MAGNITUDE else printed)
            got = amount_of.get(code)
            rows_checked += 1
            if got is None or round(got - want, 2) != 0:
                reds.append("%s %s: printed %.2f under %s entered %s, want %.2f"
                            % (case, code, printed, convention["convention"],
                               got, want))
        other = _rewrite(rows, set(r["cont"].strip() for r in contra))
        shaped_other, pl_other = _assemble(other)
        for key in PL_KEYS:
            metamorphic += 1
            if round(pl[key] - pl_other[key], 2) != 0:
                reds.append("%s %s: %s %.2f, the same ledger in the other "
                            "exporter convention (%s) %.2f"
                            % (case, key, convention["convention"], pl[key],
                               _convention(shaped_other)["convention"],
                               pl_other[key]))
    conventions = sorted(set(c["convention"] for c in decided.values()))
    with capsys.disabled():
        print("\nconvention per document: %s" % "; ".join(
            "%s %s (%d mirrored contra rows, net %.2f)"
            % (case, c["convention"], c["mirrored_contra_rows"],
               c["mirrored_contra_sum"]) for case, c in sorted(decided.items())))
        print("mirrored contra rows checked %d; metamorphic comparisons %d"
              % (rows_checked, metamorphic))
    _WORK["rows_checked"] = rows_checked
    _WORK["metamorphic"] = metamorphic
    assert tbp.CONTRA_ENTRY_MAGNITUDE in conventions, \
        "no entry-magnitude document in scope (TC-3): %s" % conventions
    assert tbp.CONTRA_NATURAL_SIGNED in conventions, \
        "no natural-signed document in scope (TC-3): %s" % conventions
    assert rows_checked > 0 and metamorphic > 0, "nothing was checked (TC-3)"
    assert not reds, "\n".join(reds)


_WORK = {"rows_checked": 0, "metamorphic": 0}  # type: Dict[str, int]


def test_zz_scope_and_work(capsys):
    books = len([c for c in _xlsx_cases() if _parse(c) is not None]) + 1 + len(_local_books())
    units = books + _WORK["rows_checked"] + _WORK["metamorphic"]
    with capsys.disabled():
        print("GATE-WORK statements-anchor-gap units=%d" % units)
    assert units > 0
