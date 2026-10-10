"""The ONLY readers the attention composer uses on a served period body.

Two figures are being redefined by other lanes while this block ships, so
each has exactly one reader here and nothing else in the package touches
the underlying fields:

  EBITDA         `served_ebitda` returns the served `assembled_pl.ebitda`
                 and its typed refusal. The 711/722 ruling (design A) moves
                 the definition and adds a refusal when the stock variation
                 cannot be measured; the day it lands, THIS function is the
                 one place that learns the refusal's field.

  INVENTORY DAYS `inventory_days` returns THE served block (schema
                 inventory_days/1, engine.ratios.inventory_days: the split
                 by stock type on the average where the book carries the
                 opening) — its total, the served basis and its LABEL (the
                 words a surface prints, never the code), and the block's
                 own `claim_policy` (owner inventory-days ruling, point 5:
                 no slow claim without the split and the average). No
                 block → refused `inventory_days_absent`; there is no
                 fallback formula (the ratio table's `dio` row reads this
                 block too).

  CREDIT REGIME  `credit_regime` returns the served credit envelope's
                 `regime` (`assembled_metrics.credit.regime`, credit model
                 revision 5, owner ruling R1): the stock-build regime the
                 grade was composed under, with its label, trigger figures,
                 cash basis and finding — verbatim, or None under the
                 standard model. Printed ONCE by the command bar.

Also here: the same-length prior rule (the dashboard's default comparison,
frontend/lib/comparatives.ts `pickDefaultPrior`, now owned by the engine) as
a pure function over period rows, so the route and its tests share one rule.

Pure: no I/O, no clock. Python 3.9 — no `match`, no `X | Y`.
"""
from __future__ import annotations

import calendar
from typing import Any, Dict, Iterable, List, Mapping, Optional

__all__ = [
    "served_ebitda",
    "credit_regime",
    "receiver_headline",
    "inventory_days",
    "anchor_status",
    "insights_block",
    "period_facts",
    "cut_of",
    "same_length_prior",
    "year_back",
    "INVENTORY_DAYS_ABSENT_POLICY",
]


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def _statements(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    st = payload.get("statements") if isinstance(payload, Mapping) else None
    return st if isinstance(st, Mapping) else {}


def _pl(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    pl = _statements(payload).get("assembled_pl")
    return pl if isinstance(pl, Mapping) else {}


# ── EBITDA ───────────────────────────────────────────────────────────────


def served_ebitda(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """{value, refusal, source}. `value` is the served figure or None;
    `refusal` is the served typed refusal (`assembled_pl.ebitda_refusal`,
    the field design A serves when net 711 is refused) or, when no figure
    is served at all, `ebitda_absent`. Never 0 for an absent figure."""
    pl = _pl(payload)
    value = _num(pl.get("ebitda"))
    refusal = pl.get("ebitda_refusal")
    if isinstance(refusal, Mapping) and refusal.get("code"):
        return {"value": None, "refusal": dict(refusal), "source": "assembled_pl.ebitda"}
    if value is None:
        return {"value": None,
                "refusal": {"code": "ebitda_absent", "inputs": ["assembled_pl.ebitda"]},
                "source": "assembled_pl.ebitda"}
    return {"value": value, "refusal": None, "source": "assembled_pl.ebitda"}


# ── Credit regime (credit model revision 5) ──────────────────────────────


def credit_regime(payload: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The served credit envelope's `regime`, verbatim (a copy), or None.

    Read from `assembled_metrics.credit` — the envelope the period route
    serves through the credit boundary — and from nowhere else: the
    attention document never runs the credit model. None when the envelope
    names no regime (the standard model) or is absent."""
    import copy

    am = payload.get("assembled_metrics") if isinstance(payload, Mapping) else None
    credit = am.get("credit") if isinstance(am, Mapping) else None
    regime = credit.get("regime") if isinstance(credit, Mapping) else None
    if not isinstance(regime, Mapping) or not regime.get("code"):
        return None
    return copy.deepcopy(dict(regime))


# ── Inventory days ───────────────────────────────────────────────────────

#: What a period that serves NO inventory-days block may claim: nothing —
#: the split by stock type is not available (the block's own policy code
#: for an unavailable split, packs/ratios/inventory_days.yaml
#: `claim_policy.reasons.split_refused`).
INVENTORY_DAYS_ABSENT_POLICY = {
    "may_call_slow": False,
    "requires": ["split_by_stock_type", "average_balance"],
    "reason": "split_refused",
}


def _inventory_block(payload: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """THE served block: GET /api/period serves it as
    `statements.inventory_days` and — the same object — as
    `assembled_metrics.inventory_days`."""
    from engine.ratios.inventory_days import served_block  # local: keeps this module's import floor

    block = served_block(_statements(payload))
    if block is None:
        am = payload.get("assembled_metrics") if isinstance(payload, Mapping) else None
        if isinstance(am, Mapping):
            block = served_block({"inventory_days": am.get("inventory_days")})
    return block


def inventory_days(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """{value, value_q, basis, basis_label, source, claim_policy, reason}.

    Reads THE served block (schema inventory_days/1). `basis` is the served
    code (average_monthly | average_two_year_ends | year_end_snapshot),
    `basis_label` the served {ro, en} words a surface prints beside the
    figure — never the code. A refused block serves `value` None and the
    block's reason; no block serves `inventory_days_absent`. Computes
    nothing, and never reads another formula: the retired ratio-table
    fallback (inventory ÷ total operating cost at the period end) is gone —
    the ratio table's `dio` row reads this block."""
    block = _inventory_block(payload)
    if block is None:
        return {"value": None, "value_q": None, "basis": None, "basis_label": None,
                "source": "statements.inventory_days",
                "claim_policy": dict(INVENTORY_DAYS_ABSENT_POLICY),
                "reason": {"code": "inventory_days_absent",
                           "inputs": ["statements.inventory_days"]}}
    total = block.get("total") if isinstance(block.get("total"), Mapping) else {}
    policy = block.get("claim_policy")
    label = block.get("basis_label")
    return {
        "value": _num(total.get("value")),
        "value_q": total.get("value_q"),
        "basis": block.get("basis"),
        "basis_label": dict(label) if isinstance(label, Mapping) else None,
        "source": "statements.inventory_days",
        "claim_policy": dict(policy) if isinstance(policy, Mapping)
        else dict(INVENTORY_DAYS_ABSENT_POLICY),
        "reason": dict(total["reason"]) if isinstance(total.get("reason"), Mapping) else None,
    }


# ── The number a receiver heads with ─────────────────────────────────────


def receiver_headline(payload: Mapping[str, Any], evidence: Mapping[str, Any]) -> Optional[float]:
    """The served figure the receiver an item opens would print FIRST — or
    None when that receiver heads with no figure of its own (an account
    view of cited accounts, a benchmark row read elsewhere).

      statement  the line's served value: the comparatives line registry's
                 path (engine.comparatives.lines), EBITDA through
                 `served_ebitda` (its one reader);
      ratio      the served ratio-table row's `value`.

    The composer holds an item's printed figure to this number: a receiver
    that heads with ANOTHER number (753,070.01 other operating income and
    provision reversals opening "Other operating income 448,406.27") sends
    the reader to a contradiction."""
    from engine.comparatives.lines import spec_for  # local: keeps this module's import floor

    kind = evidence.get("kind")
    if kind == "statement":
        line = str(evidence.get("line") or "")
        if line == "pl.ebitda":
            return served_ebitda(payload)["value"]
        spec = spec_for(line)
        if spec is None:
            return None
        node: Any = _statements(payload)
        for part in spec.path:
            if not isinstance(node, Mapping):
                return None
            node = node.get(part)
        return _num(node)
    if kind == "ratio":
        am = payload.get("assembled_metrics") if isinstance(payload, Mapping) else None
        table = am.get("ratio_table") if isinstance(am, Mapping) and isinstance(am.get("ratio_table"), Mapping) else {}
        row = next((r for r in table.get("rows") or []
                    if isinstance(r, Mapping) and r.get("key") == evidence.get("ratio")), None)
        return _num(row.get("value")) if isinstance(row, Mapping) else None
    return None


# ── The rest of the served body ──────────────────────────────────────────


def anchor_status(payload: Mapping[str, Any]) -> Optional[str]:
    """`assembled_pl.net_income_anchor_status` — whether the served net
    result IS account 121 (anchored | within_tolerance | absent)."""
    status = _pl(payload).get("net_income_anchor_status")
    return status if isinstance(status, str) else None


def insights_block(payload: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """`statements.insights`, or None when the period serves none (the key
    is ABSENT when the book could not be read — never an empty block)."""
    block = _statements(payload).get("insights")
    if isinstance(block, Mapping) and isinstance(block.get("insights"), list):
        return block
    return None


def period_facts(payload: Mapping[str, Any]) -> Dict[str, Any]:
    period = payload.get("period") if isinstance(payload.get("period"), Mapping) else {}
    org = payload.get("organization") if isinstance(payload.get("organization"), Mapping) else {}
    st = _statements(payload)
    return {
        "id": period.get("id"),
        "period_start": period.get("period_start"),
        "period_end": period.get("period_end"),
        "label": st.get("periodLabel") or period.get("period_end"),
        "company_name": org.get("name") or st.get("companyName"),
        "org_id": org.get("id"),
        "currency": st.get("currency") or period.get("currency"),
    }


# ── The same-length prior (the dashboard's default comparison) ──────────


def cut_of(iso: Any) -> Optional[str]:
    """"MM-DD" of an ISO date, with a month's last day read as "MM-end" —
    28 February 2025 and 29 February 2024 close the same month. The twin of
    `cutOf` in frontend/lib/comparatives.ts."""
    text = str(iso or "")[:10]
    if len(text) != 10 or text[4] != "-" or text[7] != "-":
        return None
    try:
        y, m, d = int(text[:4]), int(text[5:7]), int(text[8:10])
    except ValueError:
        return None
    if not (1 <= m <= 12):
        return None
    last = calendar.monthrange(y, m)[1]
    if not (1 <= d <= last):
        return None
    return "%s-%s" % (text[5:7], "end" if d == last else text[8:10])


def year_back(iso: Any) -> Optional[str]:
    """The same close one year earlier, read the way `cut_of` reads it: a
    month-end close maps to the month-end a year before (28 Feb 2025 ->
    29 Feb 2024, 29 Feb 2024 -> 28 Feb 2023)."""
    text = str(iso or "")[:10]
    cut = cut_of(text)
    if cut is None:
        return None
    y = int(text[:4]) - 1
    m = int(text[5:7])
    last = calendar.monthrange(y, m)[1]
    d = last if cut.endswith("-end") else min(int(text[8:10]), last)
    return "%04d-%02d-%02d" % (y, m, d)


def same_length_prior(periods: Iterable[Mapping[str, Any]],
                      current: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """The same company's immediately preceding period of the SAME LENGTH
    (owner rule, 2026-09-26): the nearest EARLIER period that closes on the
    same month/day — and, when both starts are known, opens on the same
    month/day. A Romanian balance is cumulative, so a Nov close is eleven
    months and is never the default for a December. `periods` must already
    be the company's periods that carry a live financial document (the
    route filters that; the dashboard lists exactly those). None when no
    such period exists. Deterministic: period_end desc, then id asc."""
    end = str(current.get("period_end") or "")[:10]
    end_cut = cut_of(end)
    if end_cut is None:
        return None
    start_cut = cut_of(current.get("period_start"))
    found = []  # type: List[Mapping[str, Any]]
    for p in periods:
        if not isinstance(p, Mapping) or p.get("id") == current.get("id"):
            continue
        p_end = str(p.get("period_end") or "")[:10]
        if not p_end or not p_end < end or cut_of(p_end) != end_cut:
            continue
        p_start = cut_of(p.get("period_start"))
        if start_cut and p_start and p_start != start_cut:
            continue
        found.append(p)
    if not found:
        return None
    found.sort(key=lambda p: str(p.get("id") or ""))
    found.sort(key=lambda p: str(p.get("period_end") or "")[:10], reverse=True)
    return found[0]
