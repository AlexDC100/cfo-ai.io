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
        Derived as `net_income_operational` + the named build-up
        components (`_named_build_up_components`: net 72x, and net 711
        when it was measured without account 121) — the assembler's own
        pre-override expression, so this costs nothing and needs no
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
    statutory = _num("net_income_statutory")

    # A REFUSED net result (`net_income_refusal`: no account 121 and a
    # refused net 711) has no reconstruction either: the build-up lacks the
    # unmeasured 711, which is exactly why the result was refused. Serving
    # it here would put that short figure back on the page under "built
    # from the accounts" (the report printed it on the row after the
    # refusal).
    refused = isinstance(pl.get("net_income_refusal"), dict)
    pl["net_income_reconstructed"] = (
        round(operational + _named_build_up_components(pl), 2)
        if operational is not None and not refused else None
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


def _named_build_up_components(pl: Dict[str, Any]) -> float:
    """What the class-6/7 BUILD-UP adds to `net_income_operational`,
    derived from the NAMED components the assembly serves — never from a
    hard-coded "operational + 722" identity (owner ruling 2026-09-26):

      · net 72x — `capitalized_own_work.value`;
      · net 711 — `inventory_variation.value`, but ONLY when it was
        measured without account 121 (`measured_without_121`: its own
        movement on an open book, an exact zero, a filed statutory row).
        The account-121 bridge is derived FROM 121; a "reconstruction"
        containing it would equal 121 by construction and the anchor
        label would stop meaning anything. A refused 711 is not a line
        the build-up has.

    A payload from a pack that serves no named blocks (the HU pack, a
    pre-ruling cache) keeps the one component it does name,
    `capitalized_own_work_memo`.
    """
    def _val(x: Any) -> float:
        return float(x) if isinstance(x, (int, float)) else 0.0

    cap_block = pl.get("capitalized_own_work")
    inv_block = pl.get("inventory_variation")
    if isinstance(cap_block, dict):
        total = _val(cap_block.get("value"))
    else:
        total = _val(pl.get("capitalized_own_work_memo"))
    if isinstance(inv_block, dict) and inv_block.get("measured_without_121"):
        total += _val(inv_block.get("value"))
    return total


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
