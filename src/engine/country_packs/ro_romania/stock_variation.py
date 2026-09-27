"""NET 711 AND NET 72x — measured from the trial balance's own leaves.

THE RULING (owner, 2026-09-26). Account 711 goes INSIDE EBITDA and the
operating result, with its sign, presented as "Variația stocurilor de
produse" next to cost of sales — never as revenue, never inside cifra de
afaceri. 722 (own work capitalised) the same way: operating, inside
EBITDA, outside turnover. One definition everywhere, with the
reconciliation line shown.

WHY THE NUMBER HAS TO BE MEASURED, NOT READ. The engine read account 711
the way it reads every class-6/7 account: the larger side of its "sume
totale". On a CLOSED trial balance (every class-6/7 leaf closed into 121,
so cumulative debit = cumulative credit and the closing column is zero —
all ten real books in the measurement) that is the GROSS production
stocked, not the variation: 630,091,698.19 on Scandia Food FY2025 against
a filed variation of about 1.08M, margins of 98.9 %-191.0 % on every
manufacturer. The direct net Σ(credit − debit) is 0.00 on every closed
book by construction. Neither is the variation.

What IS the variation on a closed book is the account-121 bridge:

    net 711 = account 121 − (every other P&L line) − net 72x

refereed against the Ministry of Finance filings on every book where the
filing can referee the revenue side, to within 0.84 lei (specs-durable/
ebitda711/measure.md, T2/T7). It is only as good as the anchor and the
reading of every other P&L line, so it is GUARDED (G1-G6 below) and it
REFUSES rather than approximates.

THE RULE (measure.md "The rule", implemented here, decided nowhere else):

  book state                                  net 711            provenance
  ──────────────────────────────────────────  ─────────────────  ───────────────────────
  any state, no 711 activity                  0.00 exactly       no_711_activity
  OPEN (6/7 leaves carry their own net)       Σ(st_c − st_d)     711_net_movement
  CLOSED, 711 activity, G2-G6 hold            the 121 bridge     account_121_bridge
  otherwise (MIXED, unanchored, a guard       REFUSED, typed     —
  fails, evidence absent)

  G1 book state CLOSED            G4 no class-6/7 leaf with activity unread
  G2 account 121 anchor applied   G5 |residual| ≤ 711 activity
  G3 711 activity > 0             G6 121's opening (prior-year result)
                                     shown cleared in the period
  G7 the period's rows were read by the RUNNING trial-balance parser
     (design A10): the residual is 121 less every line the parser read,
     so a period persisted by an older parser folds that parser's reading
     differences into "stock variation" (Carniprod 7c29a71b: turnover
     99,424,740.16 served against 94,509,940 filed — a −4.41M "711"). It
     refuses `reprocess_required` until the document is reprocessed.

The bridge never returns 0.00 when the anchor is absent: absent anchor is
a refusal (G2), never a zero.

Net 72x (721/722/725 — the accounts the pack routes to own work
capitalised): CLOSED → Σ st_c (exact while 72x is one-sided, the value the
engine served); OPEN → Σ(st_c − st_d).

TWO HALVES, TWO TIMES.
  · ``measure(tb_rows)`` — PURE, at PERSIST time, from the parsed rows
    (``pipeline._deterministic_tb_parsed`` and ``RomaniaPack.
    assemble_parsed_tb`` call it). Its output (schema ``stock_variation/1``)
    is stored on the period envelope (``assembled_canonical_v1.
    stock_variation``) because the rows are never persisted: a served
    period is rebuilt from line items, which carry one collapsed amount
    per account and cannot tell a closed book from an open one.
  · ``decide(...)`` — at every ASSEMBLY (write path and every rebuild),
    from the stored evidence plus the assembly's own reconstruction and
    anchor. ``chart_of_accounts.assemble_statements`` is its only caller.

Python 3.9 — no ``match``, no ``X | Y``. No I/O, no clock.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

__all__ = [
    "SCHEMA",
    "LINE_NAME_RO",
    "measure",
    "evidence_from_statutory_return",
    "absent_evidence",
    "is_measured",
    "leaf_flags",
    "decide",
    "refusal_text",
    "running_parser_version",
]

#: The persisted evidence block's schema. Bump on any change to what the
#: block records or how ``decide`` reads it.
SCHEMA = "stock_variation/1"

#: The owner's name for the line — verbatim, never translated in a table.
LINE_NAME_RO = "Variația stocurilor de produse"
LINE_GLOSS_EN = "change in inventories of finished goods and work in progress"

CAPITALIZED_NAME_RO = "Producția realizată pentru scopuri proprii și capitalizată"
CAPITALIZED_GLOSS_EN = "own work capitalised"

# ── Book states ───────────────────────────────────────────────────────
CLOSED = "closed"
OPEN = "open"
MIXED = "mixed"
#: The document lists no class-6/7 leaf at all (a balance-sheet extract).
NO_PL_ACTIVITY = "no_pl_activity"
#: A document with no cumulative block whose class-6/7 closing column is
#: all zero: the P&L was closed and the movements are not in the file.
CLOSED_WITHOUT_MOVEMENTS = "closed_without_movements"
#: An ANAF statutory return (F20/F30): the variation is printed net.
STATUTORY_RETURN = "statutory_return"

# ── Evidence bases ────────────────────────────────────────────────────
BASIS_TRIAL_BALANCE = "trial_balance"
BASIS_STATUTORY = "statutory_return"
BASIS_ABSENT = "absent"

# ── Provenance keys (net 711) ─────────────────────────────────────────
PROV_MOVEMENT = "711_net_movement"
PROV_NO_ACTIVITY = "no_711_activity"
PROV_BRIDGE = "account_121_bridge"
PROV_STATUTORY = "statutory_return_rows_net"

#: Provenances whose value is measured WITHOUT account 121 — the only ones
#: a class-6/7 build-up may contain. The bridge is derived FROM 121, so a
#: reconstruction that added it would equal 121 by construction.
MEASURED_WITHOUT_121 = (PROV_MOVEMENT, PROV_NO_ACTIVITY, PROV_STATUTORY)

# ── Provenance keys (net 72x) ─────────────────────────────────────────
PROV_72X_CLOSED = "72x_credit_turnover_closed_book"
PROV_72X_MOVEMENT = "72x_net_movement"
PROV_72X_NO_ACTIVITY = "no_72x_activity"
#: No trial-balance evidence: the engine's own read of the 72x lines
#: (the larger side of each account's cumulative turnover).
PROV_72X_ENGINE_READ = "72x_engine_read"

# ── Refusal codes ─────────────────────────────────────────────────────
REASON_PREDATES = "period_predates_stock_variation_measurement"
REASON_ENVELOPE_NOT_READ = "stock_variation_evidence_not_read"
REASON_EVIDENCE_ABSENT = "stock_variation_evidence_absent"
REASON_NO_TB_COLUMNS = "trial_balance_columns_unavailable"
REASON_MIXED = "book_state_mixed"
REASON_MOVEMENTS_ABSENT = "pl_movements_absent"
REASON_UNANCHORED = "account_121_anchor_absent"
REASON_UNREAD = "unread_pl_activity"
REASON_DOUBLE_READ = "pl_total_row_read_as_account"
REASON_RESIDUAL = "residual_exceeds_711_activity"
REASON_OPENING = "account_121_opening_not_cleared"
REASON_REPROCESS = "reprocess_required"

_REFUSAL_TEXT = {
    REASON_PREDATES: (
        "perioada a fost analizată înainte ca variația stocurilor să fie măsurată din balanță; "
        "se recalculează la reprocesarea documentului",
        "the period was analysed before the stock variation was measured from the trial "
        "balance; it is recomputed when the document is reprocessed",
    ),
    REASON_ENVELOPE_NOT_READ: (
        "măsurarea variației stocurilor nu a fost citită împreună cu perioada",
        "the stock-variation measurement was not read with this period",
    ),
    REASON_EVIDENCE_ABSENT: (
        "balanța nu a fost disponibilă pentru a măsura variația stocurilor",
        "the trial balance was not available to measure the stock variation",
    ),
    REASON_NO_TB_COLUMNS: (
        "documentul nu are coloanele balanței (rulaje și solduri) din care se măsoară variația stocurilor",
        "the document carries no trial-balance columns (turnover and balances) to measure the "
        "stock variation from",
    ),
    REASON_MIXED: (
        "balanța este parțial închisă (unele conturi de venituri și cheltuieli sunt închise în 121, "
        "altele nu), deci variația stocurilor nu poate fi măsurată",
        "the trial balance is partly closed (some revenue and expense accounts are closed into "
        "121, others are not), so the stock variation cannot be measured",
    ),
    REASON_MOVEMENTS_ABSENT: (
        "balanța este închisă și nu conține rulajele conturilor de venituri și cheltuieli",
        "the trial balance is closed and carries no turnover for the revenue and expense accounts",
    ),
    REASON_UNANCHORED: (
        "balanța este închisă, iar contul 121 lipsește: variația stocurilor (711) nu are sold net "
        "și nu poate fi derivată",
        "the trial balance is closed and account 121 is absent: the stock variation (711) keeps "
        "no net balance and cannot be derived",
    ),
    REASON_UNREAD: (
        "conturi de venituri sau cheltuieli cu rulaj nu au fost citite, iar suma lor s-ar afișa ca "
        "variație a stocurilor",
        "revenue or expense accounts with turnover were not read, and their amount would print as "
        "stock variation",
    ),
    REASON_DOUBLE_READ: (
        "balanța conține rânduri de total pentru conturi de venituri sau cheltuieli, citite și ca "
        "conturi, deci diferența față de contul 121 nu este variația stocurilor",
        "the trial balance carries total rows for revenue or expense accounts that are also read "
        "as accounts, so the difference to account 121 is not the stock variation",
    ),
    REASON_RESIDUAL: (
        "diferența față de contul 121 depășește rulajul contului 711, deci nu poate fi variația "
        "stocurilor",
        "the difference to account 121 exceeds the turnover of account 711, so it cannot be the "
        "stock variation",
    ),
    REASON_OPENING: (
        "soldul inițial al contului 121 (rezultatul anului anterior) nu apare închis în perioadă, "
        "deci ar intra în variația stocurilor",
        "the opening balance of account 121 (the prior-year result) is not shown cleared in the "
        "period, so it would enter the stock variation",
    ),
    REASON_REPROCESS: (
        "balanța a fost citită cu o versiune anterioară a cititorului de balanțe, deci diferența "
        "față de contul 121 poate fi o diferență de citire, nu variația stocurilor; se recalculează "
        "la reprocesarea documentului",
        "the trial balance was read by an earlier version of the trial-balance reader, so the "
        "difference to account 121 may be a reading difference, not the stock variation; it is "
        "recomputed when the document is reprocessed",
    ),
}

#: Cent slack for exact comparisons (float representation only).
EPS = 0.005
#: The measurement's matching tolerance for ledger movements (lei).
LEDGER_TOLERANCE = 1.0
MOVEMENT_MATCH_TOLERANCE = 0.05
#: How many offending codes a block lists (the count is always exact).
_LIST_CAP = 20


def running_parser_version() -> str:
    """The trial-balance reader this process runs (G7). Every row block
    ``measure`` sees comes from it: rows are never persisted, so a block
    stamped with another version was measured by an earlier deploy."""
    from .trial_balance_parser import PARSER_VERSION

    return str(PARSER_VERSION)


def refusal_text(code: str) -> Tuple[str, str]:
    """(RO, EN) sentence for a refusal code. Unknown codes are a bug."""
    return _REFUSAL_TEXT[code]


def _refusal(code: str) -> Dict[str, Any]:
    ro, en = refusal_text(code)
    return {"code": code, "text_ro": ro, "text_en": en}


def _f(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _r2(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(float(value), 2)


def _norm(code: str) -> str:
    """Digits only — the prefix classification key (``635.10`` → ``63510``)."""
    return code.replace(".", "").replace(" ", "").replace("'", "").replace("-", "")


def leaf_flags(codes: List[str]) -> List[bool]:
    """True for each code that is a LEAF of the listed chart.

    A dotted code is a parent only across a dot (``635.10`` is NOT the
    parent of ``635.103``; it is the parent of ``635.10.3``); an undotted
    code is a parent of anything it prefixes (``635`` of ``6351`` and of
    ``635.103``). The measurement's rule (measure.md, "Leaf rule") —
    a plain-prefix rule dropped retail's ``635.10`` from its own sums.
    """
    clean = [c.replace("'", "").strip() for c in codes]
    n = len(clean)
    flags = [True] * n
    # In code order every code a row prefixes follows it directly, so the
    # scan per row stops at the first code it does not prefix.
    order = sorted(range(n), key=lambda i: clean[i])
    for pos, i in enumerate(order):
        c = clean[i]
        if not c:
            continue
        k = pos + 1
        while k < n:
            o = clean[order[k]]
            if not o.startswith(c):
                break
            if o != c and ("." not in c or o[len(c)] == "."):
                flags[i] = False
                break
            k += 1
    return flags


_FIGURES = ("si_d", "si_c", "st_d", "st_c", "sf_d", "sf_c")


def _descendants(codes: List[str], i: int, flags: List[bool]) -> List[int]:
    """Indexes of the LEAF rows the row at ``i`` is a parent of (the
    ``leaf_flags`` parent rule)."""
    c = codes[i].replace("'", "").strip()
    out = []
    for j, o in enumerate(codes):
        o = o.replace("'", "").strip()
        if j == i or not flags[j] or o == c or not o.startswith(c):
            continue
        if "." in c and o[len(c)] != ".":
            continue
        out.append(j)
    return out


def row_reading(rows: List[Mapping[str, Any]]) -> List[str]:
    """How each row is read: ``leaf``, ``aggregate`` or ``distinct``.

    The measurement reads LEAVES (``leaf_flags``). A row the leaf rule
    calls a parent is only an AGGREGATE — a total line of its own
    analytics — when its six figure columns equal the sum of its leaf
    descendants to the cent; then its figures are already in the leaves
    and it is skipped. Otherwise it is a DISTINCT account whose code
    merely prefixes another (a condensed book prints ``6028`` beside an
    unmerged ``6028.x``), and it is read like a leaf — exactly as the
    assembler reads it (the parser keeps every row). Measured on the ten
    real books: no row is anything but a leaf; the distinction exists so
    the evidence and the assembly never read two different sets of rows.
    """
    codes = [str(r.get("cont") or "").strip() for r in rows]
    flags = leaf_flags(codes)
    out: List[str] = []
    for i, (r, leaf) in enumerate(zip(rows, flags)):
        if leaf:
            out.append("leaf")
            continue
        kids = _descendants(codes, i, flags)
        same = bool(kids) and all(
            abs(_f(r.get(f)) - sum(_f(rows[j].get(f)) for j in kids)) < EPS * 2
            for f in _FIGURES)
        out.append("aggregate" if same else "distinct")
    return out


def _pl_bucket_reader():
    """(bucket_for, {PL buckets}) — lazily, the package imports this module."""
    from . import chart_of_accounts as _coa

    return _coa.bucket_for, frozenset(_coa._BUCKET_TO_PL_FIELD)


def _group_of(norm: str, bucket_for) -> Optional[str]:
    """'711' / '72x' for the accounts the pack routes to the stock-variation
    and own-work buckets — the SAME grouping the assembler reads."""
    rule = bucket_for(norm)
    if rule is None:
        return None
    if rule.bucket == "inventoryVariationMemo":
        return "711"
    if rule.bucket == "capitalizedOwnWork":
        return "72x"
    return None


def _empty_turnover() -> Dict[str, float]:
    return {"leaves": 0, "activity": 0.0, "net_movement": 0.0,
            "credit_turnover": 0.0, "debit_turnover": 0.0}


def measure(tb_rows: Iterable[Mapping[str, Any]],
            parser_version: Optional[str] = None) -> Dict[str, Any]:
    """The evidence block, from the parsed 10-column rows. PURE.

    Reads the leaves and the distinct accounts (``row_reading``); an
    aggregate row's figures are already in its leaves. The rows are read
    in CODE order, so the block is a function of the book, not of the
    order its exporter printed it in (row permutation is a metamorphic
    invariant of the whole envelope). Every number is rounded to the
    cent; counts are exact; offending-code lists are capped at 20.

    ``parser_version`` — the reader that produced the rows, recorded on the
    block so a later rebuild can apply G7 (``decide``). The pack's
    ``measure_stock_variation`` supplies it; a block recorded without one
    never bridges.
    """
    bucket_for, pl_buckets = _pl_bucket_reader()
    rows = sorted(
        (r for r in tb_rows if isinstance(r, Mapping)),
        key=lambda r: (str(r.get("cont") or "").strip(),)
        + tuple(_f(r.get(f)) for f in _FIGURES),
    )
    codes = [str(r.get("cont") or "").strip() for r in rows]
    reading = row_reading(rows)
    flags = [kind != "aggregate" for kind in reading]

    has_cumulative = any(_f(r.get("st_d")) != 0 or _f(r.get("st_c")) != 0 for r in rows)

    turnovers = {"711": _empty_turnover(), "72x": _empty_turnover()}
    listed = {"711": False, "72x": False}
    pl_leaves = 0
    pl_active = 0
    open_leaves = 0
    closed_leaves = 0
    mixed_codes: List[str] = []
    mixed_count = 0
    unread: List[Dict[str, Any]] = []
    unread_count = 0
    aggregate_pl: List[str] = []
    aggregate_pl_count = 0
    cr = 0.0   # Σ st_c, credit-natured leaves excl. 711 (T5)
    dr = 0.0   # Σ st_d, debit-natured leaves (T5)
    r121 = {"si_d": 0.0, "si_c": 0.0, "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    listed_121 = False
    clearing_leaves: List[Dict[str, Any]] = []

    for r, code, leaf in zip(rows, codes, flags):
        if not code:
            continue
        n = _norm(code)
        if not n:
            continue
        if not leaf:
            # An aggregate class-6/7 row the assembler ALSO reads (the
            # parser keeps every row): its amount is counted twice in the
            # build-up the bridge is measured against (guard G4).
            if n[0] in "67" and any(abs(_f(r.get(f))) >= EPS for f in ("st_d", "st_c", "sf_d", "sf_c")):
                aggregate_pl_count += 1
                if len(aggregate_pl) < _LIST_CAP:
                    aggregate_pl.append(code)
            continue
        si_d, si_c = _f(r.get("si_d")), _f(r.get("si_c"))
        st_d, st_c = _f(r.get("st_d")), _f(r.get("st_c"))
        sf_d, sf_c = _f(r.get("sf_d")), _f(r.get("sf_c"))

        if n.startswith("121"):
            listed_121 = True
            for k, v in (("si_d", si_d), ("si_c", si_c), ("st_d", st_d),
                         ("st_c", st_c), ("sf_d", sf_d), ("sf_c", sf_c)):
                r121[k] += v
            continue
        if n.startswith(("129", "117")):
            clearing_leaves.append({"code": code, "si_d": si_d, "si_c": si_c,
                                    "st_d": st_d, "st_c": st_c})
            continue
        if n[0] not in "67":
            continue

        pl_leaves += 1
        # A document with no cumulative block carries the period's P&L in
        # its closing column (the parser reads it there too).
        mv_d, mv_c = (st_d, st_c) if has_cumulative else (sf_d, sf_c)
        active = any(abs(x) >= EPS for x in (st_d, st_c, sf_d, sf_c))
        group = _group_of(code, bucket_for)
        if group is not None:
            listed[group] = True
            t = turnovers[group]
            t["leaves"] += 1
            t["activity"] += max(abs(mv_c), abs(mv_d))
            t["net_movement"] += mv_c - mv_d
            t["credit_turnover"] += mv_c
            t["debit_turnover"] += mv_d

        credit_natured = (n.startswith("7") and not n.startswith("709")) or n.startswith("609")
        if credit_natured:
            if group != "711":
                cr += st_c
        else:
            dr += st_d

        if not active:
            continue
        pl_active += 1

        # G4 — the leaf must be READ into a P&L bucket by the pack's rules
        # (the deterministic parser drops a code with no rule into
        # `unmapped`; the assembler skips a bucket that is not a P&L line).
        rule = bucket_for(code)  # the code exactly as the parser hands it
        reason = None
        if rule is None:
            reason = "no_rule"
        elif rule.bucket not in pl_buckets:
            reason = "not_a_pl_line:%s" % rule.bucket
        if reason is not None:
            unread_count += 1
            if len(unread) < _LIST_CAP:
                unread.append({"code": code, "st_d": _r2(st_d), "st_c": _r2(st_c),
                               "sf_d": _r2(sf_d), "sf_c": _r2(sf_c), "reason": reason})

        # G1 — the leaf's own closing state.
        if has_cumulative:
            closed = abs(sf_d) < EPS and abs(sf_c) < EPS and abs(st_d - st_c) < EPS
            carries_own_net = abs((sf_c - sf_d) - (st_c - st_d)) < EPS
            if closed:
                closed_leaves += 1
            elif carries_own_net:
                open_leaves += 1
            else:
                mixed_count += 1
                if len(mixed_codes) < _LIST_CAP:
                    mixed_codes.append(code)
        else:
            if abs(sf_d) >= EPS or abs(sf_c) >= EPS:
                open_leaves += 1
            else:
                closed_leaves += 1

    if pl_leaves == 0:
        state = NO_PL_ACTIVITY
    elif not has_cumulative and open_leaves == 0:
        # Closed, and the movements are not in the file.
        state = CLOSED_WITHOUT_MOVEMENTS if pl_active else NO_PL_ACTIVITY
    elif mixed_count:
        state = MIXED
    elif open_leaves:
        # Every active leaf carries its own net. That alone does not make
        # the book open: a monthly-closing exporter whose December is not
        # yet closed prints the same shape (Jan-Nov closing entries cancel
        # inside the cumulative columns, December's net sits in both). The
        # tell is account 121 — an open book posted NO closing entry to it
        # in the period (at most the transfer of its opening balance).
        state = OPEN if _open_book_121_clean(r121) else MIXED
    elif pl_active:
        state = CLOSED
    else:
        state = NO_PL_ACTIVITY

    # ── Account 121: the opening (prior-year result) and the year's sides ─
    opening = r121["si_c"] - r121["si_d"]
    closing = r121["sf_c"] - r121["sf_d"]
    st_includes_si = abs((r121["st_c"] - r121["st_d"]) - closing) < MOVEMENT_MATCH_TOLERANCE
    yc = r121["st_c"] - (r121["si_c"] if st_includes_si else 0.0)
    yd = r121["st_d"] - (r121["si_d"] if st_includes_si else 0.0)

    cleared_by: Optional[Dict[str, Any]] = None
    if abs(opening) < EPS:
        cleared_by = {"kind": "opening_zero"}
    else:
        for leaf_row in clearing_leaves:
            lyc = leaf_row["st_c"] - (leaf_row["si_c"] if st_includes_si else 0.0)
            lyd = leaf_row["st_d"] - (leaf_row["si_d"] if st_includes_si else 0.0)
            if opening > 0 and abs(lyc - opening) <= MOVEMENT_MATCH_TOLERANCE:
                cleared_by = {"kind": "equal_movement", "code": leaf_row["code"],
                              "side": "credit", "amount": _r2(lyc)}
                break
            if opening < 0 and abs(lyd + opening) <= MOVEMENT_MATCH_TOLERANCE:
                cleared_by = {"kind": "equal_movement", "code": leaf_row["code"],
                              "side": "debit", "amount": _r2(lyd)}
                break

    def _t(group: str) -> Dict[str, Any]:
        t = turnovers[group]
        return {"listed": listed[group], "leaves": t["leaves"],
                "activity": _r2(t["activity"]), "net_movement": _r2(t["net_movement"]),
                "credit_turnover": _r2(t["credit_turnover"]),
                "debit_turnover": _r2(t["debit_turnover"])}

    return {
        "schema": SCHEMA,
        "basis": BASIS_TRIAL_BALANCE,
        "parser_version": parser_version,
        "book_state": state,
        "has_cumulative": has_cumulative,
        "pl_leaves": pl_leaves,
        "pl_leaves_active": pl_active,
        "pl_leaves_closed": closed_leaves,
        "pl_leaves_open": open_leaves,
        "pl_leaves_mixed": mixed_count,
        "mixed_codes": mixed_codes,
        "a711": _t("711"),
        "a72x": _t("72x"),
        "unread_pl_count": unread_count,
        "unread_pl": unread,
        "aggregate_pl_count": aggregate_pl_count,
        "aggregate_pl": aggregate_pl,
        "account_121": {
            "listed": listed_121,
            "opening": _r2(opening),
            "closing": _r2(closing),
            "year_credits": _r2(yc),
            "year_debits": _r2(yd),
            "st_includes_si": st_includes_si,
        },
        "nature_reads": {
            "credit_natured_excl_711": _r2(cr),
            "debit_natured": _r2(dr),
        },
        "opening_cleared_by": cleared_by,
    }


def _open_book_121_clean(r121: Mapping[str, float]) -> bool:
    """An OPEN book's 121 receives no closing entries in the period: its
    year movements are nothing, or exactly the transfer of its opening."""
    opening = r121["si_c"] - r121["si_d"]
    closing = r121["sf_c"] - r121["sf_d"]
    incl = abs((r121["st_c"] - r121["st_d"]) - closing) < MOVEMENT_MATCH_TOLERANCE
    yc = r121["st_c"] - (r121["si_c"] if incl else 0.0)
    yd = r121["st_d"] - (r121["si_d"] if incl else 0.0)
    transfer = abs(opening)
    return (abs(yc) < EPS or abs(yc - transfer) < MOVEMENT_MATCH_TOLERANCE) and (
        abs(yd) < EPS or abs(yd - transfer) < MOVEMENT_MATCH_TOLERANCE)


def evidence_from_statutory_return(net_711: float) -> Dict[str, Any]:
    """An ANAF statutory return prints the variation NET (rows "Venituri
    aferente costului producției în curs de execuție", sold C / sold D).
    Nothing to derive: the filed figure is the measurement."""
    return {
        "schema": SCHEMA,
        "basis": BASIS_STATUTORY,
        "book_state": STATUTORY_RETURN,
        "statutory_net_711": _r2(net_711),
    }


def absent_evidence(reason: str) -> Dict[str, Any]:
    """A marker for 'no evidence' carrying WHY. Never persisted."""
    refusal_text(reason)  # an unknown reason is a bug, raised here
    return {"schema": SCHEMA, "basis": BASIS_ABSENT, "absent_reason": reason}


def is_measured(evidence: Any) -> bool:
    """True for a block ``measure`` / ``evidence_from_statutory_return``
    produced (the only blocks a period envelope may store)."""
    return (isinstance(evidence, Mapping) and evidence.get("schema") == SCHEMA
            and evidence.get("basis") in (BASIS_TRIAL_BALANCE, BASIS_STATUTORY))


# ── Labels ────────────────────────────────────────────────────────────

_LABEL_711 = {
    PROV_BRIDGE: (
        LINE_NAME_RO + " — derivată: rezultatul din contul 121 minus celelalte linii ale "
        "contului de profit și pierdere (o balanță închisă nu păstrează soldul net al contului 711)",
        "Change in inventories of finished goods and WIP — derived: the result in account 121 "
        "less every other P&L line (a closed trial balance keeps no net balance on account 711)",
    ),
    PROV_MOVEMENT: (
        LINE_NAME_RO + " (711, sold C − sold D)",
        "Change in inventories of finished goods and WIP (711, credit − debit)",
    ),
    PROV_NO_ACTIVITY: (
        LINE_NAME_RO + " (711) — fără înregistrări în perioadă",
        "Change in inventories of finished goods and WIP (711) — no postings in the period",
    ),
    PROV_STATUTORY: (
        LINE_NAME_RO + " — din situațiile financiare depuse (sold C − sold D)",
        "Change in inventories of finished goods and WIP — from the filed financial statements "
        "(credit − debit balance)",
    ),
}
_LABEL_711_REFUSED = (
    LINE_NAME_RO + " — nu poate fi măsurată",
    "Change in inventories of finished goods and WIP — cannot be measured",
)
_LABEL_72X = {
    PROV_72X_CLOSED: (
        CAPITALIZED_NAME_RO + " (72x, rulaj creditor — balanță închisă)",
        "Own work capitalised (72x, credit turnover — closed trial balance)",
    ),
    PROV_72X_MOVEMENT: (
        CAPITALIZED_NAME_RO + " (72x, sold C − sold D)",
        "Own work capitalised (72x, credit − debit)",
    ),
    PROV_72X_NO_ACTIVITY: (
        CAPITALIZED_NAME_RO + " (72x) — fără înregistrări în perioadă",
        "Own work capitalised (72x) — no postings in the period",
    ),
    PROV_72X_ENGINE_READ: (
        CAPITALIZED_NAME_RO + " (72x, rulajul citit de motor)",
        "Own work capitalised (72x, the engine's read of the turnover)",
    ),
}
_SPLIT_ASSUMPTION = (
    "Împărțirea dintre 711 și 72x presupune că 722 nu are înregistrări pe debit.",
    "The split between 711 and 72x assumes 722 has no debit postings.",
)
_IDENTITY_NOTE = (
    "Pe o balanță închisă linia 711 este derivată din contul 121, deci reconcilierea se "
    "închide prin construcție.",
    "On a closed trial balance the 711 line is derived from account 121, so the "
    "reconciliation closes by construction.",
)


# ── The decision ──────────────────────────────────────────────────────

def decide(
    evidence: Optional[Mapping[str, Any]],
    *,
    account_121: Optional[float],
    net_income_operational: float,
    read_711_lines: float,
    read_72x_lines: float,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """(inventory_variation, capitalized_own_work) — the served blocks.

    ``account_121`` is the anchor the assembly APPLIED (None when it had
    none — G2 then refuses the bridge; it never becomes 0.00);
    ``net_income_operational`` the class-6/7 reconstruction excluding 711
    and 72x; ``read_711_lines`` the assembler's Σ|amount| over the 711
    line items and ``read_72x_lines`` its 72x bucket sum — used ONLY when
    no trial-balance evidence exists: to know whether the book posts to
    711 at all, and as the 72x value. Never as the 711 value.
    """
    anchor_applied = account_121 is not None
    if evidence is None:
        evidence = absent_evidence(REASON_EVIDENCE_ABSENT)
    basis = evidence.get("basis")

    # ── Net 72x ────────────────────────────────────────────────────────
    a72x = evidence.get("a72x") or {}
    state = evidence.get("book_state")
    if basis == BASIS_TRIAL_BALANCE:
        if not a72x.get("activity"):
            v72, p72 = 0.0, PROV_72X_NO_ACTIVITY
        elif state == OPEN:
            v72, p72 = _f(a72x.get("net_movement")), PROV_72X_MOVEMENT
        else:
            v72, p72 = _f(a72x.get("credit_turnover")), PROV_72X_CLOSED
    else:
        v72 = round(_f(read_72x_lines), 2)
        p72 = PROV_72X_NO_ACTIVITY if abs(v72) < EPS else PROV_72X_ENGINE_READ
    v72 = round(v72, 2)
    lr72, le72 = _LABEL_72X[p72]
    capitalized = {
        "value": v72,
        "provenance": p72,
        "line_name_ro": CAPITALIZED_NAME_RO,
        "gloss_en": CAPITALIZED_GLOSS_EN,
        "label_ro": lr72,
        "label_en": le72,
        "accounts": "72x",
    }

    # The bridge's residual: what account 121 holds beyond every other P&L
    # line. None — never 0.00 — when there is no anchor.
    residual = (round(float(account_121) - _f(net_income_operational) - v72, 2)
                if anchor_applied else None)

    block: Dict[str, Any] = {
        "schema": SCHEMA,
        "value": None,
        "refusal": None,
        "provenance": None,
        "line_name_ro": LINE_NAME_RO,
        "gloss_en": LINE_GLOSS_EN,
        "label_ro": None,
        "label_en": None,
        "accounts": "711",
        "basis": basis,
        "book_state": state,
        "activity": None,
        "has_activity": None,
        "guards": None,
        "measured_without_121": False,
        "identity_with_121": False,
        # The gross credit turnover of 711 — the production STOCKED on a
        # closed book, not the variation. Served for audit only, under a
        # name that says what it is; it feeds no number.
        "stock_production_credit_turnover": None,
    }

    def _serve(value: float, prov: str) -> None:
        block["value"] = round(float(value), 2)
        block["provenance"] = prov
        block["label_ro"], block["label_en"] = _LABEL_711[prov]
        block["measured_without_121"] = prov in MEASURED_WITHOUT_121
        block["identity_with_121"] = prov == PROV_BRIDGE

    def _refuse(code: str) -> None:
        block["refusal"] = _refusal(code)
        block["label_ro"], block["label_en"] = _LABEL_711_REFUSED

    if basis == BASIS_STATUTORY:
        v = _f(evidence.get("statutory_net_711"))
        block["has_activity"] = abs(v) >= EPS
        block["activity"] = _r2(abs(v))
        _serve(v, PROV_STATUTORY if block["has_activity"] else PROV_NO_ACTIVITY)
    elif basis != BASIS_TRIAL_BALANCE:
        # No trial-balance evidence. The line items still say whether the
        # book posts to 711 at all: every non-zero 711 read becomes a line.
        # With no 711 line the variation is exactly zero; with one it is
        # unmeasurable here and refuses with the evidence's reason.
        seen = abs(_f(read_711_lines)) >= EPS
        block["has_activity"] = seen
        block["stock_production_credit_turnover"] = _r2(read_711_lines) if seen else 0.0
        if not seen:
            block["activity"] = 0.0
            _serve(0.0, PROV_NO_ACTIVITY)
        else:
            _refuse(str(evidence.get("absent_reason") or REASON_EVIDENCE_ABSENT))
    else:
        a711 = evidence.get("a711") or {}
        activity = _f(a711.get("activity"))
        block["activity"] = _r2(activity)
        block["stock_production_credit_turnover"] = _r2(_f(a711.get("credit_turnover")))
        unread_n = int(evidence.get("unread_pl_count") or 0)
        double_n = int(evidence.get("aggregate_pl_count") or 0)
        acc121 = evidence.get("account_121") or {}
        opening = _f(acc121.get("opening"))
        cleared = evidence.get("opening_cleared_by")
        cleared_kind = (cleared or {}).get("kind") if isinstance(cleared, Mapping) else None
        ledger = None
        if cleared_kind is None and abs(opening) >= EPS:
            # The 121 ledger (measure.md T5): on an exporter that closes
            # every P&L account on its nature side, 121's debit side is the
            # debit-natured reads plus a prior-year PROFIT transfer, and its
            # credit side less the credit-natured reads is 711 plus a
            # prior-year LOSS transfer.
            nat = evidence.get("nature_reads") or {}
            cside = _f(acc121.get("year_credits")) - _f(nat.get("credit_natured_excl_711"))
            dside = _f(acc121.get("year_debits")) - _f(nat.get("debit_natured"))
            c711 = cside - (-opening if opening < 0 else 0.0)
            dres = dside - (opening if opening > 0 else 0.0)
            ledger = (residual is not None and abs(c711 - residual) <= LEDGER_TOLERANCE
                      and abs(dres) <= LEDGER_TOLERANCE)
            if ledger:
                cleared_kind = "account_121_ledger"
        # G7 (design A10): the residual may be folded into 711 only when the
        # rows were read by the running parser. A block stamped by an older
        # reader (or not stamped) was measured before the current reading.
        stored_parser = evidence.get("parser_version")
        running_parser = running_parser_version()
        guards = {
            "G1_book_state": state,
            "G2_anchored": bool(anchor_applied),
            "G3_activity": _r2(activity),
            "G4_unread_pl": unread_n,
            "G4_double_read_pl": double_n,
            "G5_residual": residual,
            "G5_within_activity": (None if residual is None
                                   else abs(residual) <= activity + EPS),
            "G6_opening": _r2(opening),
            "G6_cleared_by": cleared_kind,
            "G7_parser_version": stored_parser,
            "G7_running_parser_version": running_parser,
            "G7_current": stored_parser == running_parser,
        }
        block["guards"] = guards
        listed_711 = bool(a711.get("listed"))
        block["has_activity"] = activity >= EPS
        if activity < EPS:
            if state == CLOSED_WITHOUT_MOVEMENTS and listed_711:
                # A 711 account listed on a closed file with no turnover
                # columns: its postings are invisible, not absent.
                block["has_activity"] = None
                _refuse(REASON_MOVEMENTS_ABSENT)
            else:
                _serve(0.0, PROV_NO_ACTIVITY)
        elif state == OPEN:
            _serve(_f(a711.get("net_movement")), PROV_MOVEMENT)
        elif state == MIXED:
            _refuse(REASON_MIXED)
        elif state != CLOSED:
            _refuse(REASON_MOVEMENTS_ABSENT)
        elif not anchor_applied:
            _refuse(REASON_UNANCHORED)
        elif not guards["G7_current"]:
            _refuse(REASON_REPROCESS)
        elif unread_n:
            _refuse(REASON_UNREAD)
        elif double_n:
            _refuse(REASON_DOUBLE_READ)
        elif not guards["G5_within_activity"]:
            _refuse(REASON_RESIDUAL)
        elif cleared_kind is None:
            _refuse(REASON_OPENING)
        else:
            _serve(float(residual), PROV_BRIDGE)

    if block["identity_with_121"]:
        block["identity_note_ro"], block["identity_note_en"] = _IDENTITY_NOTE
    if (block["value"] is not None and abs(block["value"]) >= EPS and abs(v72) >= EPS
            and block["provenance"] == PROV_BRIDGE):
        capitalized["split_assumption_ro"], capitalized["split_assumption_en"] = _SPLIT_ASSUMPTION
    return block, capitalized
