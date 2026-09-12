"""Account-121 anchor provenance — ONE code object, every seam.

`net_income_statutory` is the account-121 closing balance whenever the
assembler's override fires, and a class-6/7 reconstruction otherwise.
The two are different numbers on real books (37.9x apart on
`saga_10_col_realestate`), so the served figure is only readable
alongside a label saying which one it is.

This module holds that labelling. It lives in `engine.core` — below both
`engine.api.pipeline` (the served/persist seams) and
`engine.country_packs.ro_romania.pack` (the OFFLINE seam that
`scripts/verify_determinism.py`, `scripts/reprocess_documents.py`,
`scripts/measure_bs_drift.py`, `scripts/measure_error_budget.py` and
`scripts/corpus_replay.py` all run) — so neither has to import the
other and neither can carry a second, drifting copy of the rule.

Before this module existed the rule lived only in
`pipeline._annotate_net_income_anchor`, whose own docstring claims it is
"called on EVERY path that produces an `assembled_pl` ... so the field
set never depends on which seam the reader came through". The offline
path produced an `assembled_pl` and never called it: the VALUE agreed to
the cent on all 15 corpus books, but the four provenance fields were
simply absent, so every offline harness audited a P&L that could not say
whether its own statutory figure was anchored or reconstructed.
`tests/engine/test_offline_served_parity.py` is the gate that keeps the
two field sets identical.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: `net_income_statutory` equals account 121 to the cent.
NET_INCOME_ANCHOR_ANCHORED = "anchored"
#: The anchor reached the assembler and the assembler kept its own
#: reconstruction (inside its band).
NET_INCOME_ANCHOR_WITHIN_TOLERANCE = "within_tolerance"
#: No anchor reached the assembler — the served figure is a
#: reconstruction and says so.
NET_INCOME_ANCHOR_ABSENT = "absent"

#: The four fields this helper owns. Named so a gate can assert the set
#: rather than re-listing it (and so a fifth field can never be added on
#: one seam only).
NET_INCOME_ANCHOR_FIELDS = (
    "net_income_reconstructed",
    "net_income_statutory_anchor",
    "net_income_anchor_source",
    "net_income_anchor_status",
)

#: Every seam that resolves the anchor off parsed trial-balance rows
#: labels it the same way, so a reader never has to know which seam
#: produced the payload.
ANCHOR_SOURCE_PARSED_TB_ROWS = "parsed_tb_rows"


def annotate_net_income_anchor(
    assembled: Optional[Dict[str, Any]],
    anchor: Optional[float],
    source: Optional[str],
    *,
    applied: bool,
) -> None:
    """Stamp the anchor provenance onto `assembled.statements
    .assembled_pl`, in place.

    Adds, always:
      · ``net_income_reconstructed``   the class-6/7 build-up, i.e. the
        number `net_income_statutory` would carry with no anchor.
        Derived as `net_income_operational + capitalized_own_work_memo`
        — that identity IS the assembler's pre-override expression
        (chart_of_accounts.py:1069), so this costs nothing and needs no
        second assembly.
      · ``net_income_statutory_anchor``  account 121, or null.
      · ``net_income_anchor_source``     where the anchor came from.
      · ``net_income_anchor_status``     anchored | within_tolerance |
        absent.

    `net_income_statutory` itself is left ALONE — never nulled. The
    frontend reads it through `?? 0` fallbacks
    (frontend/lib/canonicalMetrics.ts), so a null would render as a
    fabricated zero. A labelled number the reader can check beats a
    blank they cannot.

    STATUS IS OBSERVED, NOT RE-DERIVED — reading the decision off the
    assembler's OUTPUT, rather than re-implementing its threshold here,
    is what stops this helper from drifting away from the rule it
    reports on. `applied` is what makes that reading safe: without it, a
    site that resolved the anchor and forgot to pass it would produce a
    large gap and get labelled `within_tolerance` — the exact defect,
    wearing a reassuring label.

    `net_income_statutory_anchor` is emitted whenever an anchor was
    RESOLVED, `applied` or not, so a reader can always see the account
    121 figure and check the gap themselves.
    """
    if not isinstance(assembled, dict):
        return
    pl = ((assembled.get("statements") or {}) or {}).get("assembled_pl")
    if not isinstance(pl, dict):
        return

    def _num(key: str) -> Optional[float]:
        val = pl.get(key)
        return float(val) if isinstance(val, (int, float)) else None

    operational = _num("net_income_operational")
    capitalized = _num("capitalized_own_work_memo")
    statutory = _num("net_income_statutory")

    pl["net_income_reconstructed"] = (
        round(operational + (capitalized or 0.0), 2)
        if operational is not None else None
    )
    pl["net_income_statutory_anchor"] = (
        round(float(anchor), 2) if anchor is not None else None
    )
    pl["net_income_anchor_source"] = source if anchor is not None else None
    if anchor is None or not applied:
        pl["net_income_anchor_status"] = NET_INCOME_ANCHOR_ABSENT
    elif statutory is not None and abs(statutory - float(anchor)) < 0.005:
        pl["net_income_anchor_status"] = NET_INCOME_ANCHOR_ANCHORED
    else:
        pl["net_income_anchor_status"] = NET_INCOME_ANCHOR_WITHIN_TOLERANCE


def annotate_from_parsed_tb_rows(
    assembled: Optional[Dict[str, Any]], anchor: Optional[float],
) -> None:
    """The one call shape both trial-balance seams use: the anchor came
    off parsed TB rows, and it is `applied` exactly when it exists.

    `pipeline.stage_map` and `RomaniaPack.assemble_parsed_tb` are the two
    callers; keeping the `source` / `applied` derivation here means they
    cannot label the same book differently.
    """
    annotate_net_income_anchor(
        assembled,
        anchor,
        ANCHOR_SOURCE_PARSED_TB_ROWS if anchor is not None else None,
        applied=anchor is not None,
    )
