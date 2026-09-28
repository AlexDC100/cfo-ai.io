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

REWRITTEN FOR THE ONE-EBITDA RULING (owner, 2026-09-26) — not re-captured
=======================================================================
The law used to judge the SERVED `net_income_unexplained_vs_121`. Since the
ruling the engine NAMES net 711 on the statement and, on a closed book, it
is the account-121 bridge — derived FROM that very remainder — so the
served remainder is 0.00 on every closed manufacturer BY CONSTRUCTION
(agras, carniprod, frozen, the developer): the gate had gone vacuous on
exactly the books whose floor is widest. It now judges the STEP BEFORE THE
FOLD, S = account 121 − (the class-6/7 build-up + net 72x), which is what
the old field measured and what the engine's own guard G5 bounds (|S| ≤
711 activity), and it holds the fold itself:

  · bridge (account_121_bridge): served net 711 = S to the cent, the served
    remainder 0.00, and the provenance says the line is derived from 121;
  · no 711 postings (no_711_activity): net 711 exactly 0.00 and the served
    remainder = S — NEVER folded into 711;
  · 711 measured on its own (711_net_movement): remainder = S − net 711;
  · 711 refused: the remainder holds S whole and EBITDA is refused with the
    711 reason.

A CONSTRUCTED witness (SYNTHETIC books of the net-711-rule gate, no client
data) proves the judge still reds on a real misread: the no-711 book whose
121 exceeds the accounts by 2,000.00 is BEYOND its one-cent floor, and the
book whose remainder exceeds its 711 turnover is BEYOND its floor AND
refused by the engine (G5) — the pack's floor and the engine's guard are
the same law, checked here against each other. A scope with no such
witness is red (TC-3).
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
            "production_stock_prefixes": tuple(str(p) for p in gap["production_stock_prefixes"]),
            "sentence_fallback_floor": gap["sentence_fallback_floor"],
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


def _production_stock_movement(rows, prefixes) -> Optional[Decimal]:
    """Closing less opening net debit balance of the production-stock
    accounts; None when the book carries no such row."""
    total = Decimal("0")
    seen = False
    for r in rows:
        code = (r.get("cont") or "").strip()
        if not code.startswith(prefixes):
            continue
        seen = True
        d = lambda k: Decimal(str(r.get(k) or 0))  # noqa: E731
        total += (d("sf_d") - d("sf_c")) - (d("si_d") - d("si_c"))
    return total.quantize(Decimal("0.01")) if seen else None


def _step_before_the_fold(pl) -> Decimal:
    """S = account 121 − (build-up + net 72x): the step BEFORE net 711 is
    named. `net_income_reconciliation_to_121` is the whole step from the
    build-up (which excludes 711 and 72x) to 121; the 72x the statement
    names is taken off. It is NOT the served remainder, which is taken
    after the fold and is 0.00 on a bridge book by construction."""
    cap = (pl.get("capitalized_own_work") or {}).get("value")
    if cap is None:
        cap = pl.get("capitalized_own_work_memo") or 0
    return (Decimal(str(pl["net_income_reconciliation_to_121"]))
            - Decimal(str(cap))).quantize(Decimal("0.01"))


def _gap_and_floor_live(rows, pl, pack) -> Tuple[Optional[Decimal], Decimal, Decimal]:
    """(step before the fold, floor, hidden turnover) for a parsed book.
    step None: no 121."""
    anchor = tbp.compute_statutory_net_profit_anchor(rows)
    if anchor is None:
        return None, pack["cent_tolerance"], Decimal("0")
    gap = _step_before_the_fold(pl)
    hidden = _hidden_turnover(rows, pack["hidden_net_prefixes"])
    return gap, pack["cent_tolerance"] + hidden, hidden


def fold_problems(name: str, step: Decimal, pl: Dict[str, Any]) -> List[str]:
    """How the served statement FOLDS the step S into its lines (the ruling
    2026-09-26): bridge → net 711 = S, remainder 0; no 711 postings → 711
    0.00, remainder S (never folded); an own movement → remainder S − 711;
    refused → remainder S and EBITDA refused with the 711 reason."""
    out = []  # type: List[str]
    inv = pl.get("inventory_variation") or {}
    rem = Decimal(str(pl.get("net_income_unexplained_vs_121") or 0)).quantize(Decimal("0.01"))
    prov = inv.get("provenance")
    val = inv.get("value")
    cent = Decimal("0.01")
    if not inv:
        return ["%s: the statement serves no inventory_variation block" % name]
    if inv.get("refusal"):
        if abs(rem - step) > cent:
            out.append("%s: 711 refused, yet the remainder %s is not the whole step %s"
                       % (name, rem, step))
        if pl.get("ebitda") is not None or (pl.get("ebitda_refusal") or {}).get("code") \
                != inv["refusal"].get("code"):
            out.append("%s: 711 refused (%s) but EBITDA %r / its refusal %r"
                       % (name, inv["refusal"].get("code"), pl.get("ebitda"),
                          (pl.get("ebitda_refusal") or {}).get("code")))
        return out
    v = Decimal(str(val)).quantize(Decimal("0.01"))
    if prov == "account_121_bridge":
        if abs(v - step) > cent or abs(rem) > cent or not inv.get("identity_with_121"):
            out.append("%s: bridge 711 %s, step %s, remainder %s, identity flag %r"
                       % (name, v, step, rem, inv.get("identity_with_121")))
    elif prov == "no_711_activity":
        if v != 0 or abs(rem - step) > cent:
            out.append("%s: no 711 postings, yet 711 %s / remainder %s vs step %s — "
                       "a remainder was folded" % (name, v, rem, step))
    else:
        if abs(rem - (step - v)) > cent:
            out.append("%s: %s 711 %s, remainder %s, step %s" % (name, prov, v, rem, step))
    return out


def _gap_and_floor_baseline(pack) -> Tuple[Decimal, Decimal, Decimal, Dict[str, Any]]:
    """The committed Scandia FY2025 regression baseline carries aggregates
    only (no rows): 121 from its p121 block, the build-up as
    net_income_operational + capitalized own work (the step BEFORE the
    fold, as on the live books), the hidden turnover as the 711 gross
    credit turnover the statement serves under its audit name
    (`inventory_variation.stock_production_credit_turnover` — the retired
    `inventory_variation_memo` on a baseline captured before the ruling;
    either IS the 711 turnover on a mirrored book)."""
    data = json.loads(BASELINE.read_text(encoding="utf-8"))
    pl = data["assembled"]["statements"]["assembled_pl"]
    inv = data["assembled"]["assembled_canonical_v1"]["canonical_bs"]["invariants"]["p121_cross_check"]
    p121 = Decimal(str(inv["p121"]))
    reconstruction = (Decimal(str(pl["net_income_operational"]))
                      + Decimal(str(pl.get("capitalized_own_work_memo") or 0)))
    gap = (p121 - reconstruction).quantize(Decimal("0.01"))
    block = pl.get("inventory_variation") or {}
    turnover = block.get("stock_production_credit_turnover")
    if turnover is None:
        turnover = pl["inventory_variation_memo"]
    hidden = Decimal(str(turnover)).quantize(Decimal("0.01"))
    return gap, pack["cent_tolerance"] + hidden, hidden, {
        "company": data["_meta"].get("company"), "p121": p121,
        "reconstruction": reconstruction, "pl": pl}


def test_a_the_reconstruction_reaches_account_121_within_the_pack_floor(capsys):
    pack = _pack()
    lines = []  # type: List[str]
    reds = []  # type: List[str]
    examined = 0
    with_121 = 0
    conventions = {}  # type: Dict[str, str]
    residuals = {}  # type: Dict[str, Decimal]
    folds = {}  # type: Dict[str, str]

    def fold(name: str, step: Decimal, pl: Dict[str, Any]) -> None:
        """The ruling's half: how the statement names the step (above)."""
        inv = pl.get("inventory_variation") or {}
        folds[name] = (inv.get("provenance")
                       or "refused:%s" % ((inv.get("refusal") or {}).get("code")))
        lines.append("  %-40s   fold: step before the fold %s -> net 711 %s (%s), "
                     "remainder served %s" % ("", step, inv.get("value"), folds[name],
                                               pl.get("net_income_unexplained_vs_121")))
        reds.extend(fold_problems(name, step, pl))

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
        if gap is not None:
            fold(("corpus " + case), gap, pl)
        if gap is not None and hidden > 0:
            # B4V-7a: what the hidden net can actually be, and what is left
            movement = _production_stock_movement(rows, pack["production_stock_prefixes"])
            if movement is None:
                lines.append("  %-40s   fallback floor; no production-stock rows to read a movement from" % "")
            else:
                residual = (abs(gap) - abs(movement)).quantize(Decimal("0.01"))
                residuals["corpus " + case] = residual
                lines.append("  %-40s   %s: production stock %s moved %s; residual beyond it %s (NOT judged)"
                             % ("", pack["sentence_fallback_floor"].split(":")[0], "/".join(pack["production_stock_prefixes"]),
                                movement, residual))

    gap, floor, hidden, meta = _gap_and_floor_baseline(pack)
    base_name = "regression baseline scandia_fy2025 (%s)" % meta["company"]
    judge(base_name, gap, floor, hidden, "aggregates only (no rows to decide from)")
    if "inventory_variation" in meta["pl"]:
        fold(base_name, gap, meta["pl"])
    else:
        lines.append("  %-40s   fold: baseline captured before the ruling "
                     "(no inventory_variation block) — the fold is not judged" % "")

    for name, path in _local_books().items():
        rows = _parse_bytes(name, path.read_bytes(), path.name)
        if rows is None:
            lines.append("  %-40s does not parse (out of scope)" % name)
            continue
        shaped, pl = _assemble(rows)
        gap, floor, hidden = _gap_and_floor_live(rows, pl, pack)
        judge(name, gap, floor, hidden, _convention(shaped)["convention"])
        if gap is not None:
            fold(name, gap, pl)

    with capsys.disabled():
        print("\nSCOPE statements-anchor-gap (plan/2 B4a, contract 5.1): books examined %d "
              "(%d carry account 121), floor from %s#anchor_gap"
              % (examined, with_121, PACK.relative_to(REPO)))
        print("\n".join(lines))
        print("fold per book (ruling 2026-09-26): %s"
              % "; ".join("%s %s" % (k, v) for k, v in sorted(folds.items())))
    _WORK["folds"] = len(folds)
    assert examined > 0 and with_121 > 0, "no book with account 121 examined (TC-3)"
    # TC-3 for the fold: the bridge must be exercised, or "S is folded
    # into 711 exactly" is asserted on nothing.
    assert "account_121_bridge" in folds.values(), folds
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


_WORK_RULE = {"checks": 0, "documents": set()}  # type: Dict[str, Any]

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


_WORK = {"rows_checked": 0, "metamorphic": 0, "folds": 0, "witnesses": 0}  # type: Dict[str, int]


# ── the decision RULE itself (plan/2 B4 repair, B4V-7b/c) ───────────────
# Every real book prints both families on one sign, so deciding from the
# 709 rows only, or by row count instead of the net, passed this gate. The
# documents below are TEST-BUILT from the retail corpus rows (SYNTHETIC,
# TC-13): the same ledger with one family re-printed or removed. The law
# each holds: whatever the exporter prints, the statement is the retail
# statement to the cent — revenue, cost of sales, operating cost and the
# tie to account 121.

SYNTHETIC_DOCS = ("609-only", "709-only", "mixed (709 natural-signed, 609 magnitudes)",
                  "storno-heavy (many small natural-signed 709 rows beside one large magnitude row)")


def _family_codes(rows):
    cost, revenue = set(), set()
    for r in _mirrored_contra(rows):
        code = (r.get("cont") or "").strip()
        rule = coa.bucket_for(code)
        family = tbp._pl_contra_family(code, rule.bucket, credit_pos_pl=_CREDIT_POS_PL,
                                       debit_pos_pl=_DEBIT_POS_PL)
        (cost if family == tbp.CONTRA_FAMILY_COST else revenue).add(code)
    return cost, revenue


def test_e_a_mixed_family_document_reads_each_family_by_its_own_rows(capsys):
    rows = _parse("saga_10_col_retail")
    _shaped, want = _assemble(rows)
    cost, revenue = _family_codes(rows)
    assert cost and revenue, "retail no longer carries both contra families (TC-3)"
    mixed = _rewrite(rows, revenue)  # the 709 family printed natural-signed
    shaped, got = _assemble(mixed)
    convention = _convention(shaped)
    _WORK_RULE["documents"].add(SYNTHETIC_DOCS[2])
    assert convention["convention"] == tbp.CONTRA_MIXED, convention
    fam = convention["families"]
    assert fam[tbp.CONTRA_FAMILY_COST]["convention"] == tbp.CONTRA_ENTRY_MAGNITUDE, fam
    assert fam[tbp.CONTRA_FAMILY_REVENUE]["convention"] == tbp.CONTRA_NATURAL_SIGNED, fam
    for key in PL_KEYS:
        _WORK_RULE["checks"] += 1
        assert round(got[key] - want[key], 2) == 0, (
            "SYNTHETIC %s: %s %.2f, the same ledger printed in one convention "
            "gives %.2f (delta %.2f) — a natural-signed 709 was negated because "
            "the 609 rows print magnitudes" % (SYNTHETIC_DOCS[2], key, got[key],
                                               want[key], got[key] - want[key]))
    assert round(got["net_income_unexplained_vs_121"], 2) == 0, got
    with capsys.disabled():
        print("SYNTHETIC %s: convention %s (%s); revenue %.2f, unexplained vs 121 %.2f"
              % (SYNTHETIC_DOCS[2], convention["convention"],
                 ", ".join("%s %s" % (k, v["convention"]) for k, v in sorted(fam.items())),
                 got["revenue"], got["net_income_unexplained_vs_121"]))


@pytest.mark.parametrize("keep", ("609-only", "709-only"))
def test_f_a_document_with_one_contra_family_decides_that_family(keep, capsys):
    rows = _parse("saga_10_col_retail")
    cost, revenue = _family_codes(rows)
    drop = revenue if keep == "609-only" else cost
    kept_family = tbp.CONTRA_FAMILY_COST if keep == "609-only" else tbp.CONTRA_FAMILY_REVENUE
    only = [r for r in copy.deepcopy(rows) if (r.get("cont") or "").strip() not in drop]
    shaped, got = _assemble(only)
    convention = _convention(shaped)
    _WORK_RULE["documents"].add(keep)
    assert convention["convention"] == tbp.CONTRA_ENTRY_MAGNITUDE, (keep, convention)
    assert list(convention["families"]) == [kept_family], convention
    # the kept family still enters as a reduction: every mirrored row negated
    by_code = dict(((a.get("ro_account_code") or a.get("code")), a) for a in shaped)
    for r in _mirrored_contra(only):
        code = (r.get("cont") or "").strip()
        _WORK_RULE["checks"] += 1
        assert round(float(by_code[code]["amount"]) + float(r["st_c"]), 2) == 0, (
            keep, code, by_code[code]["amount"], r["st_c"])
    with capsys.disabled():
        print("SYNTHETIC %s: %d mirrored contra rows, convention %s"
              % (keep, convention["mirrored_contra_rows"], convention["convention"]))


def test_g_the_net_decides_never_the_row_count(capsys):
    """Storno-heavy: the 709 family keeps its large magnitude row and gains
    many small NEGATIVE mirrored rows (stornos of reductions). By row count
    the family looks natural-signed; by its net it is entry-magnitude."""
    rows = copy.deepcopy(_parse("saga_10_col_retail"))
    _cost, revenue = _family_codes(rows)
    template = max((r for r in rows if (r.get("cont") or "").strip() in revenue),
                   key=lambda r: float(r["st_c"]))
    big = float(template["st_c"])
    assert big > 100, "the shape proves nothing: largest mirrored 709 row is %.2f" % big
    n_real = len(revenue)
    for i in range(n_real + 3):
        storno = dict(template)
        storno["cont"] = "%s.S%02d" % (template["cont"], i)
        for col in ("r_d", "r_c", "st_d", "st_c"):
            if storno.get(col) not in (None, ""):
                storno[col] = -0.01
        for col in ("si_d", "si_c", "sf_d", "sf_c"):
            if col in storno:
                storno[col] = 0.0
        rows.append(storno)
    decision = tbp.contra_reading(rows).convention
    fam = decision["families"][tbp.CONTRA_FAMILY_REVENUE]
    _WORK_RULE["documents"].add(SYNTHETIC_DOCS[3])
    _WORK_RULE["checks"] += 1
    negative = sum(1 for r in rows if (r.get("cont") or "").startswith(template["cont"] + ".S"))
    assert negative > n_real, (negative, n_real)  # TC-3: a row-count majority WOULD say natural
    assert fam["convention"] == tbp.CONTRA_ENTRY_MAGNITUDE, (
        "SYNTHETIC %s: %d negative rows against %d positive, net %.2f — the "
        "family was decided by row count" % (SYNTHETIC_DOCS[3], negative, n_real,
                                             fam["mirrored_contra_sum"]))
    with capsys.disabled():
        print("SYNTHETIC %s: %d negative rows, %d positive, net %.2f -> %s"
              % (SYNTHETIC_DOCS[3], negative, n_real, fam["mirrored_contra_sum"],
                 fam["convention"]))


# ── CONSTRUCTED witnesses (the ruling 2026-09-26) ───────────────────────
# SYNTHETIC books of the net-711-rule gate (tests/engine/test_net_711_rule.py,
# no client data), through the same offline composition as the corpus. Each
# is a real misread the judge above must call BEYOND its floor.

WITNESSES = {
    # (book, what is misread, expected fold)
    "closed_no_activity": ("no 711 postings; account 121 exceeds the accounts by "
                           "2,000.00 (a misread row)", "no_711_activity"),
    "g5_residual": ("711 turned over 30,000.00 each side; the remainder is "
                    "larger than that turnover", "refused:residual_exceeds_711_activity"),
}


def test_h_a_constructed_misread_is_beyond_its_floor_and_the_engine_agrees(capsys):
    import test_net_711_rule as N

    pack = _pack()
    printed = []
    for name, (what, want_fold) in sorted(WITNESSES.items()):
        rows = N.BOOKS[name]()
        _shaped, pl = _assemble(rows)
        step, floor, hidden = _gap_and_floor_live(rows, pl, pack)
        assert step is not None, "%s: the witness lost its account 121" % name
        beyond = abs(step) > floor
        inv = pl["inventory_variation"]
        got_fold = inv.get("provenance") or "refused:%s" % (inv.get("refusal") or {}).get("code")
        printed.append("SYNTHETIC %s (%s): step %s, floor %s (hidden %s) -> %s; engine %s"
                       % (name, what, step, floor, hidden,
                          "BEYOND" if beyond else "within", got_fold))
        assert beyond, ("%s: a real misread sits within the floor — the judge would stay "
                        "green on it" % name)
        assert got_fold == want_fold, (name, got_fold)
        # the pack's floor and the engine's G5 are one law
        guards = inv.get("guards") or {}
        if hidden > 0:
            assert guards.get("G5_within_activity") is False, (name, guards)
        # and the fold law holds on the witness too (nothing is folded)
        assert not fold_problems(name, step, pl), fold_problems(name, step, pl)
        _WORK["witnesses"] += 1
    with capsys.disabled():
        print("\n" + "\n".join(printed))
    assert _WORK["witnesses"] == len(WITNESSES)


def test_zz_scope_and_work(capsys):
    books = len([c for c in _xlsx_cases() if _parse(c) is not None]) + 1 + len(_local_books())
    units = (books + _WORK["rows_checked"] + _WORK["metamorphic"] + _WORK_RULE["checks"]
             + _WORK["folds"] + _WORK["witnesses"])
    with capsys.disabled():
        print("SYNTHETIC decision-rule documents (test-built from the retail corpus rows): %s"
              % "; ".join(sorted(_WORK_RULE["documents"])))
        print("GATE-WORK statements-anchor-gap units=%d" % units)
    assert len(_WORK_RULE["documents"]) == len(SYNTHETIC_DOCS), _WORK_RULE["documents"]
    assert units > 0
