"""Structural impossibilities in an assembled Romanian P&L.

These are not tolerances. Each one is a shape that CANNOT be a true
reading of a trial balance that carries class 6/7 movement, so serving it
is worse than refusing: a reader believes a number, and the number is the
absence of a number.

WHY THIS EXISTS. A post-closing balanță — one whose class 6/7 accounts
are closed to account 121 every month — carries, for every revenue and
expense account, cumulative debit EQUAL to cumulative credit and a
closing balance of zero. Netting the two sides gives zero. Reading the
closing column gives zero. Only reading ONE SIDE (credit for class 7,
debit for class 6) recovers the period's activity, and the deterministic
assembler does exactly that. But nothing asserted it, so a future reader
of these columns — a new front-end, an AI lane, a refactor — could serve
revenue = 0 against a billion in turnover and nothing would object.

THE POST-CLOSING SIGNAL is deliberately NOT a fourth member of the
movements pass's A/B/C convention vote. Measured on two real books: every
class 6/7 row (104/104 and 391/391) satisfies BOTH identity B and
identity C, because both sides are equal and the closing is zero. Those
rows carry no discriminating signal at all, so a post-closing "convention"
would be voted on by rows that cannot inform it, against a C that already
wins at rate 1.0. It is an orthogonal property of how the P&L is
PRESENTED, and it is reported alongside the convention, never inside it.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

#: Below this, a book has no meaningful P&L and the checks stand down —
#: a balance-sheet-only extract is a legitimate document, not a defect.
MATERIAL_MOVEMENT_RON = 1_000.0

#: Cent-level slack. These are exact-arithmetic checks; the tolerance
#: exists only to absorb float representation, never to admit a real gap.
EPS = 0.005


class PlSanityRefused(ValueError):
    """An assembled P&L that must not be served, with a code the caller
    can branch on and a message a finance reader can act on."""

    def __init__(self, code: str, message: str, detail: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}


def _net(row: Mapping[str, Any], d: str, c: str) -> float:
    return float(row.get(d) or 0.0) - float(row.get(c) or 0.0)


def class_movement(tb_rows: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
    """One-sided cumulative movement for classes 6 and 7, plus the
    post-closing signal. Reads the RAW parsed rows, never the assembly."""
    c6_d = c6_c = c7_d = c7_c = 0.0
    c70_c = 0.0
    c6_sf = c7_sf = 0.0
    n6 = n7 = 0
    for r in tb_rows:
        code = str(r.get("cont") or "").strip()
        if not code:
            continue
        if code[0] == "6":
            n6 += 1
            c6_d += float(r.get("st_d") or 0.0)
            c6_c += float(r.get("st_c") or 0.0)
            c6_sf += abs(_net(r, "sf_d", "sf_c"))
        elif code[0] == "7":
            n7 += 1
            if code.startswith("70"):
                c70_c += float(r.get("st_c") or 0.0)
            c7_d += float(r.get("st_d") or 0.0)
            c7_c += float(r.get("st_c") or 0.0)
            c7_sf += abs(_net(r, "sf_d", "sf_c"))
    # POST-CLOSING: every P&L account closed out — the two sides agree and
    # nothing is left standing in the closing column.
    sides_agree = (abs(c6_d - c6_c) < EPS) and (abs(c7_d - c7_c) < EPS)
    closings_zero = (c6_sf < EPS) and (c7_sf < EPS)
    return {
        "class6_debit": c6_d, "class6_credit": c6_c, "class6_rows": n6,
        "class7_debit": c7_d, "class7_credit": c7_c, "class7_rows": n7,
        "class6_abs_closing": c6_sf, "class7_abs_closing": c7_sf,
        "post_closing": bool(sides_agree and closings_zero and (c7_c > MATERIAL_MOVEMENT_RON)),
        # What a one-sided read recovers — the figures the assembler must
        # produce if it is reading the book correctly.
        "class70_credit": c70_c,
        "one_sided_class7_credit": c7_c,
        "one_sided_class6_debit": c6_d,
    }


def check(pl: Mapping[str, Any], tb_rows: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """The three structural checks. Returns findings; raises nothing.

    Each finding carries `blocking: True` when the shape is impossible
    rather than merely odd — the caller refuses on those.
    """
    rows = list(tb_rows)
    mv = class_movement(rows)
    findings: List[Dict[str, Any]] = []

    revenue = float(pl.get("revenue") or 0.0)
    total_opex = float(pl.get("total_operating_expense") or 0.0)
    ebitda = pl.get("ebitda")

    # ── 3a. Revenue of zero against material class-7 movement ─────────
    # A book carrying a billion of class-7 turnover cannot serve revenue
    # = 0. The only ways to reach it are netting the two sides of a
    # post-closing book, or reading its (zero) closing column.
    # Triggered on class 70 — the turnover accounts that BECOME revenue —
    # not on all of class 7. A real-estate developer legitimately carries
    # tens of millions of 711 production variation against almost no
    # turnover, and refusing that book would be the gate encoding a wrong
    # law (measured: corpus/saga_10_col_realestate, 29.59M of 711 against
    # 162,365.46 of class 70, served exactly).
    if abs(revenue) < EPS and mv["class70_credit"] > MATERIAL_MOVEMENT_RON:
        findings.append({
            "code": "PL1_ZERO_REVENUE_WITH_MOVEMENT",
            "blocking": True,
            "message": (
                "Revenue assembled to 0.00 while the trial balance carries "
                "%s RON of class-7 credit movement across %d accounts. A "
                "book with turnover cannot have zero revenue; this is a "
                "reading fault, not a result. If the P&L accounts are "
                "closed to 121 (post-closing: %s), period activity must be "
                "read from ONE SIDE — credit for class 7, debit for class 6 "
                "— never netted and never from the closing column."
                % ("{:,.2f}".format(mv["class7_credit"]), mv["class7_rows"],
                   mv["post_closing"])
            ),
            "observed": {"revenue": revenue, "class7_credit": mv["class7_credit"],
                         "post_closing": mv["post_closing"]},
        })

    # ── 3b. EBITDA exactly equal to minus operating expenses ──────────
    # The signature of revenue that went missing: every cost landed, no
    # income did. Exact equality, because a real book's EBITDA lands on
    # that value only by a coincidence of the cent.
    if (ebitda is not None and total_opex > MATERIAL_MOVEMENT_RON
            and abs(float(ebitda) + total_opex) < EPS):
        findings.append({
            "code": "PL2_EBITDA_IS_MINUS_OPEX",
            "blocking": True,
            "message": (
                "EBITDA assembled to exactly minus total operating expense "
                "(%s). That is the signature of an income side that did not "
                "land: every cost was read and no revenue was. It is not a "
                "loss-making book, it is an unread one."
                % "{:,.2f}".format(float(ebitda))
            ),
            "observed": {"ebitda": float(ebitda), "total_operating_expense": total_opex},
        })

    # ── 3c. Revenue IS the one-sided class-70 credit ──────────────────
    # Not a share, not a tolerance: an EQUALITY. Measured across all 17
    # books this engine can parse — five real client-shaped corpus books,
    # a PDF, a compact 6-column layout, a real-estate developer, and both
    # real Scandia years — served `revenue` equals the sum of class-70
    # cumulative CREDIT to the cent, on every one. It is the invariant of
    # reading the income side correctly, and any other reading of those
    # columns (netting the two sides, taking the closing balance, taking
    # the debit side) breaks it immediately.
    #
    # An earlier draft of this check compared served income to ALL of
    # class 7 and refused the real-estate book, whose class 7 is 99% 711
    # production variation. That was the check being wrong, not the book.
    if mv["class70_credit"] > MATERIAL_MOVEMENT_RON or abs(revenue) > EPS:
        drift = revenue - mv["class70_credit"]
        if abs(drift) > EPS:
            findings.append({
                "code": "PL3_REVENUE_IS_NOT_THE_CLASS70_CREDIT",
                "blocking": True,
                "message": (
                    "Served revenue %s does not equal the trial balance's "
                    "class-70 cumulative credit %s (drift %s). Revenue IS "
                    "that one-sided sum; a difference means the income side "
                    "was read from the wrong column — netted, or taken from "
                    "the closing balance, which is zero on a post-closing "
                    "book (post_closing: %s)."
                    % ("{:,.2f}".format(revenue),
                       "{:,.2f}".format(mv["class70_credit"]),
                       "{:+,.2f}".format(drift), mv["post_closing"])
                ),
                "observed": {"revenue": revenue,
                             "class70_credit": mv["class70_credit"],
                             "drift": drift,
                             "post_closing": mv["post_closing"]},
            })

    return findings


def assert_servable(pl: Mapping[str, Any], tb_rows: Iterable[Mapping[str, Any]]) -> None:
    """Raise on the first blocking finding. The refusal carries the
    finance-readable message, not a stack trace."""
    for f in check(pl, tb_rows):
        if f.get("blocking"):
            raise PlSanityRefused(f["code"], f["message"], f.get("observed"))
