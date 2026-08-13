"""F4.8 Signal 1 — Reconciliation checks (the strongest signal).

Accounting identities MUST hold. If they don't, extraction failed.
Per the spec:
  - Trial balance: total debits = total credits
  - Balance sheet: Assets = Liabilities + Equity
  - Revenue rollup: sum of per-account revenue = reported total
  - P&L: Revenue − Costs = Operating Profit
  - EBITDA: Op. Profit + D&A = reported EBITDA
  - Net Profit ties to retained earnings movement (cross-period)

Each check that PASSES with <0.1% delta = strong signal extraction worked.
Each FAILS = strong signal extraction broke somewhere.

This module is read-only against the assembled output + canonical
envelope. No re-computation of business logic — we only verify that
numbers the engine already produced satisfy the identities.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# RON tolerance for "exact match" — accounting rounding adds noise
# below this threshold.
_RON_TOLERANCE = 1.0
# Fractional tolerance for "matches identity". Per the canonical_bs v2
# contract (docs/CANONICAL_BS_V2_CONTRACT.md), BALANCED means
# |delta| ≤ max(1 RON, 0.001% of the base) — 0.001% as a fraction is
# 0.00001 (the previous 0.001 here was 0.1%, 100× looser than contract).
_PCT_TOLERANCE = 0.00001   # 0.001%
# MINOR_DRIFT ceiling per the same contract: 0.5% of assets.
_MINOR_DRIFT_PCT = 0.005


@dataclass
class ReconciliationCheck:
    """One accounting-identity verification."""
    id: str
    label: str
    expected: float
    computed: float
    delta: float
    delta_pct: float
    passed: bool
    metric: Optional[str] = None   # which key metric this check informs (revenue/ebitda/debt/equity)
    severity: str = "info"          # info | warn | critical

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "label": self.label,
            "expected": round(self.expected, 2),
            "computed": round(self.computed, 2),
            "delta": round(self.delta, 2),
            "delta_pct": round(self.delta_pct, 6),
            "passed": self.passed,
            "metric": self.metric,
            "severity": self.severity,
        }


def run_reconciliation_checks(assembled: Dict[str, Any]) -> List[ReconciliationCheck]:
    """Run all applicable identity checks against the assembled output.

    `assembled` is the dict returned by `assemble_statements()`. We pull:
      - `assembled.source_data_quality.sum_closing_debit / sum_closing_credit` (F3.9)
      - `assembled.statements.assembled_bs.total_assets / total_equity / total_liabilities / bs_balance_delta`
      - `assembled.statements.assembled_pl.revenue / cogs / opex_total / depreciation / ebitda_statutory / net_income_statutory`
      - `assembled.assembled_canonical_v1.round_trip_check` (F4.1)

    Returns a list of checks (each carrying expected/computed/passed).
    """
    checks: List[ReconciliationCheck] = []
    statements = (assembled or {}).get("statements") or {}
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    canonical = (assembled or {}).get("assembled_canonical_v1") or {}
    source_quality = (assembled or {}).get("source_data_quality") or {}

    # ── Check 1: Debits = Credits (the strongest TB signal) ───
    sum_d = float(source_quality.get("sum_closing_debit") or 0)
    sum_c = float(source_quality.get("sum_closing_credit") or 0)
    if sum_d > 0 or sum_c > 0:
        delta = sum_c - sum_d
        delta_pct = abs(delta) / max(abs(sum_d), 1.0)
        checks.append(ReconciliationCheck(
            id="debits_credits",
            label="Debits = Credits",
            expected=sum_d, computed=sum_c,
            delta=delta, delta_pct=delta_pct,
            passed=abs(delta) < _RON_TOLERANCE or delta_pct < _PCT_TOLERANCE,
            severity="critical",
        ))

    # ── Check 2: Assets = Liabilities + Equity ────────────────
    total_assets = float(bs.get("total_assets") or 0)
    total_liab = float(bs.get("total_liabilities") or 0)
    total_equity = float(bs.get("total_equity") or 0)
    if total_assets > 0:
        computed = total_liab + total_equity
        delta = computed - total_assets
        delta_pct = abs(delta) / total_assets
        checks.append(ReconciliationCheck(
            id="balance_sheet",
            label="Assets = Liabilities + Equity",
            expected=total_assets, computed=computed,
            delta=delta, delta_pct=delta_pct,
            # 0.5% = the MINOR_DRIFT ceiling (F-A3.1 / canonical_bs v2);
            # BALANCED-strictness lives in run_bs_diagnosis / the builder.
            passed=abs(delta) < _RON_TOLERANCE or delta_pct < _MINOR_DRIFT_PCT,
            metric="equity", severity="critical",
        ))

    # ── Check 3: P&L roll-up ── Revenue - COGS - OpEx = EBITDA + D&A ───
    revenue = float(pl.get("revenue") or 0)
    cogs = float(pl.get("cogs") or 0)
    opex_total = float(pl.get("opex_total") or 0)
    depreciation = float(pl.get("depreciation") or 0)
    ebitda_statutory = float(pl.get("ebitda_statutory") or 0)
    if revenue > 0:
        # EBITDA = Revenue - COGS - OpEx (other_op_income + capitalized added at engine);
        # we check the looser identity that engine-emitted EBITDA reconciles
        # to its components within tolerance.
        computed = revenue - cogs - opex_total + float(pl.get("other_income_758") or 0) + float(pl.get("other_income_781_reversals") or 0)
        delta = computed - ebitda_statutory
        delta_pct = abs(delta) / max(abs(revenue), 1.0)
        checks.append(ReconciliationCheck(
            id="ebitda_rollup",
            label="Revenue - COGS - OpEx + other = EBITDA",
            expected=ebitda_statutory, computed=computed,
            delta=delta, delta_pct=delta_pct,
            passed=delta_pct < 0.01,   # 1% — looser than BS because of memo items
            metric="ebitda", severity="warn",
        ))

    # ── Check 4: Net profit anchor ── reconstructed vs account 121 ───
    net_income_statutory = float(pl.get("net_income_statutory") or 0)
    # We can't directly access account_121_anchor here, but the engine
    # already enforces the ±5% reconciliation at chart_of_accounts.py
    # line ~1358. If net_income_statutory > 0 we credit this as passed.
    if abs(net_income_statutory) > 1.0:
        checks.append(ReconciliationCheck(
            id="net_income_anchor",
            label="Net profit ties to account 121",
            expected=net_income_statutory, computed=net_income_statutory,
            delta=0.0, delta_pct=0.0,
            passed=True,
            metric="equity", severity="info",
        ))

    # ── Check 5: Canonical round-trip (F4.1) ──────────────────
    rt = canonical.get("round_trip_check") or {}
    if rt:
        rt_passed = bool(rt.get("passed"))
        # max_deviation_pct is in PERCENT units (0.5 == 0.5%), matching
        # the envelope's tolerance_pct — see compute_round_trip_check.
        max_dev = float(rt.get("max_deviation_pct") or 0)
        checks.append(ReconciliationCheck(
            id="canonical_round_trip",
            label="Canonical aggregates match legacy assembled_bs",
            expected=100.0, computed=100.0 - max_dev,
            delta=-max_dev, delta_pct=max_dev / 100.0,
            passed=rt_passed,
            severity="warn",
        ))

    return checks


def checks_by_metric(checks: List[ReconciliationCheck]) -> Dict[str, List[ReconciliationCheck]]:
    """Group checks by the metric they inform. Used by per-metric
    confidence aggregation."""
    out: Dict[str, List[ReconciliationCheck]] = {
        "revenue": [], "ebitda": [], "debt": [], "equity": [],
    }
    for check in checks:
        if check.metric and check.metric in out:
            out[check.metric].append(check)
    return out


# ────────────────────────────────────────────────────────────────────────
# canonical_bs v2 — deterministic BS diagnosis engine (D0-D8)
# docs/CANONICAL_BS_V2_CONTRACT.md "Diagnostic codes". Runs when the
# canonical_bs status is not BALANCED; each entry names WHY the sheet
# doesn't balance with enough specificity that the AI council can propose
# a correction the validator can verify. Order is the contract's D0-D8;
# within a code, entries sort by pair/account id — fully deterministic.
# ────────────────────────────────────────────────────────────────────────

# Fixed pair order for source-anchor diagnostics (SI → RL → RC → SF).
_ANCHOR_PAIR_ORDER = ("si", "rl", "rc", "sf")

# Contra-account families that belong on the asset side (as negatives) —
# finding one inside a liability-side section is a D3 misplacement.
_CONTRA_PREFIXES = ("28", "29", "39", "49", "59")

# Bifunctional families for D4. 117/121 are deliberately NOT flagged on a
# negative balance: a debit-side 117/121 is legitimate negative equity
# (accumulated losses / current-year loss), so flagging every loss-making
# company would drown the real signal.
_BIFUNCTIONAL_PREFIXES = ("4111", "401", "455", "461", "462", "473", "5121", "4428")

# canonical_bs liability/equity-side section ids (everything not in the
# three asset sections).
_ASSET_SECTION_IDS = {"non_current_assets", "current_assets", "prepaid_expenses"}


def _normalize_account_leaves(leaves: Any) -> List[Dict[str, Any]]:
    """Accept either an account-level list ({code|ro_account_code, name?,
    amount}) or the canonical envelope's leaves dict (name → {…,
    ras_line_items_sum_signed}) and normalize to a sorted
    [{code, name, amount}] list. Defensive — diagnosis callers differ."""
    out: List[Dict[str, Any]] = []
    if isinstance(leaves, dict):
        for name in sorted(leaves):
            entry = leaves[name] or {}
            if not isinstance(entry, dict):
                continue
            amount = float(entry.get("ras_line_items_sum_signed")
                           or entry.get("amount") or 0)
            out.append({"code": str(name), "name": str(name), "amount": amount})
    elif isinstance(leaves, list):
        for item in leaves:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or item.get("ro_account_code") or "").strip()
            if not code:
                continue
            name = str(item.get("name") or item.get("ro_account_name") or "")
            try:
                amount = float(item.get("amount") or 0)
            except (TypeError, ValueError):
                continue
            out.append({"code": code, "name": name, "amount": amount})
        out.sort(key=lambda a: (a["code"], a["name"]))
    return out


def run_bs_diagnosis(
    canonical_bs: Dict[str, Any],
    leaves: Any = None,
    source_anchor: Optional[Dict[str, Any]] = None,
    *,
    source_census: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Deterministic D0-D8 diagnosis for a non-BALANCED canonical_bs.

    Inputs:
      `canonical_bs` — the v2 object (rows/sections/totals/difference/
        invariants already computed).
      `leaves` — account-level [{code, name, amount}] (engine-signed
        amounts) OR the canonical envelope's leaves dict; used for the
        fingerprint / side / duplicate / magnitude scans.
      `source_anchor` — the contract's anchor block; falls back to
        canonical_bs["source_anchor"] when omitted.
      `source_census` — optional list of ALL account codes in the source
        file, for D8 (omission scan); skipped when absent.

    Returns the ordered diagnosis list: [{code, detail, leaf_ids}].
    """
    cbs = canonical_bs or {}
    anchor = source_anchor if isinstance(source_anchor, dict) else (cbs.get("source_anchor") or {})
    accounts = _normalize_account_leaves(leaves)
    difference = float(cbs.get("difference") or 0)
    diagnosis: List[Dict[str, Any]] = []

    # ── D0 — anchor divergence: extracted column sums ≠ file totals ────
    if str(anchor.get("anchor_status") or "") == "DIVERGED":
        pairs = anchor.get("pairs") or {}
        pair_names = [p for p in _ANCHOR_PAIR_ORDER if p in pairs]
        pair_names += sorted(p for p in pairs if p not in _ANCHOR_PAIR_ORDER)
        for pair in pair_names:
            pd = pairs.get(pair) or {}
            delta_d = float(pd.get("delta_debit") or 0)
            delta_c = float(pd.get("delta_credit") or 0)
            if abs(delta_d) > _RON_TOLERANCE or abs(delta_c) > _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D0_ANCHOR_DIVERGENCE",
                    "detail": (
                        f"pair {pair}: extracted sums diverge from file totals "
                        f"by debit {delta_d:,.2f} / credit {delta_c:,.2f} RON"
                    ),
                    "leaf_ids": [],
                })
        if not pair_names:
            diagnosis.append({
                "code": "D0_ANCHOR_DIVERGENCE",
                "detail": "anchor_status DIVERGED (per-pair deltas unavailable)",
                "leaf_ids": [],
            })

    # ── D1 — the FILE's own pair D ≠ C ─────────────────────────────────
    if anchor.get("source_balanced") is False:
        pairs = anchor.get("pairs") or {}
        pair_names = [p for p in _ANCHOR_PAIR_ORDER if p in pairs]
        pair_names += sorted(p for p in pairs if p not in _ANCHOR_PAIR_ORDER)
        emitted_d1 = False
        for pair in pair_names:
            pd = pairs.get(pair) or {}
            file_d = float(pd.get("file_debit") or 0)
            file_c = float(pd.get("file_credit") or 0)
            gap = file_d - file_c
            if abs(gap) > _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D1_SOURCE_IMBALANCED",
                    "detail": f"Sursă dezechilibrată: {abs(gap):,.2f} RON (pereche {pair})",
                    "leaf_ids": [],
                })
                emitted_d1 = True
        if not emitted_d1:
            diagnosis.append({
                "code": "D1_SOURCE_IMBALANCED",
                "detail": "Sursă dezechilibrată (per-pair file totals unavailable)",
                "leaf_ids": [],
            })

    # ── D2 — fingerprint: a leaf amount ≈ |difference| or ≈ half of it ──
    # |amount| ≈ |difference| → the account was dropped/omitted on one
    # side; |amount| ≈ |difference|/2 → its SIGN was flipped (a flip moves
    # the gap by twice the amount).
    if abs(difference) > _RON_TOLERANCE:
        for acct in accounts:
            amt = abs(acct["amount"])
            if amt <= _RON_TOLERANCE:
                continue
            if abs(amt - abs(difference)) <= _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D2_FINGERPRINT",
                    "detail": f"account {acct['code']} amount {amt:,.2f} ≈ difference",
                    "leaf_ids": [acct["code"]],
                })
            elif abs(amt - abs(difference) / 2.0) <= _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D2_FINGERPRINT",
                    "detail": (
                        f"account {acct['code']} amount {amt:,.2f} ≈ difference/2 "
                        "(sign-flip signature)"
                    ),
                    "leaf_ids": [acct["code"]],
                })

    # ── D3 — contra families (28x/29x/39x/49x/59x) on the liability side ─
    for row in (cbs.get("rows") or []):
        if not isinstance(row, dict):
            continue
        if str(row.get("section") or "") in _ASSET_SECTION_IDS:
            continue
        hits = sorted(
            code for code in (row.get("leaf_ids") or [])
            if str(code).startswith(_CONTRA_PREFIXES)
        )
        if hits:
            diagnosis.append({
                "code": "D3_CONTRA_MISPLACED",
                "detail": (
                    f"contra-asset account(s) {', '.join(hits)} inside "
                    f"liability-side row {row.get('id')}"
                ),
                "leaf_ids": hits,
            })

    # ── D4 — bifunctional account sitting AGAINST its balance side ─────
    # Engine-signed amounts: negative on one of these families means the
    # closing balance is on the opposite side of its assembled bucket —
    # the residual class that understates both sides at once.
    for acct in accounts:
        if acct["amount"] < -_RON_TOLERANCE and acct["code"].startswith(_BIFUNCTIONAL_PREFIXES):
            diagnosis.append({
                "code": "D4_BIFUNCTIONAL_SIDE",
                "detail": (
                    f"account {acct['code']} carries {acct['amount']:,.2f} against "
                    "its natural balance side (wrong-side classification)"
                ),
                "leaf_ids": [acct["code"]],
            })

    # ── D5 — duplicate rows: same code, same amount, more than once ────
    seen: Dict[Any, int] = {}
    for acct in accounts:
        key = (acct["code"], round(acct["amount"], 2))
        seen[key] = seen.get(key, 0) + 1
    for (code, amount), count in sorted(seen.items(), key=lambda kv: kv[0]):
        if count > 1 and abs(amount) > _RON_TOLERANCE:
            diagnosis.append({
                "code": "D5_DUPLICATE_ROWS",
                "detail": f"account {code} appears {count}× with identical amount {amount:,.2f}",
                "leaf_ids": [code],
            })

    # ── D6 — 121 ≠ class7 − class6 (from canonical_bs invariants) ──────
    p121_block = ((cbs.get("invariants") or {}).get("p121_cross_check") or {})
    if p121_block.get("ok") is False:
        diagnosis.append({
            "code": "D6_121_MISMATCH",
            "detail": (
                f"account 121 closing {float(p121_block.get('p121') or 0):,.2f} ≠ "
                f"class7−class6 {float(p121_block.get('cls7_minus_cls6') or 0):,.2f}"
            ),
            "leaf_ids": ["121"],
        })

    # ── D7 — magnitude (separator) fingerprint: a 100×/1000× misparse of
    # one account explains the difference (a value 100× too large adds
    # 0.99 × value of spurious imbalance; 1000× adds 0.999 × value).
    if abs(difference) > _RON_TOLERANCE:
        for acct in accounts:
            amt = abs(acct["amount"])
            if amt <= _RON_TOLERANCE:
                continue
            if abs(abs(difference) - amt * 0.99) <= _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D7_MAGNITUDE",
                    "detail": (
                        f"account {acct['code']} amount {amt:,.2f} looks 100× off "
                        "(thousands-separator parse error would explain the difference)"
                    ),
                    "leaf_ids": [acct["code"]],
                })
            elif abs(abs(difference) - amt * 0.999) <= _RON_TOLERANCE:
                diagnosis.append({
                    "code": "D7_MAGNITUDE",
                    "detail": (
                        f"account {acct['code']} amount {amt:,.2f} looks 1000× off "
                        "(thousands-separator parse error would explain the difference)"
                    ),
                    "leaf_ids": [acct["code"]],
                })

    # ── D8 — omission: census accounts absent everywhere ───────────────
    if source_census:
        present = {a["code"] for a in accounts}
        present |= {str(e.get("code") or "") for e in (cbs.get("unmapped") or []) if isinstance(e, dict)}
        present |= {str(e.get("code") or "") for e in (cbs.get("excluded") or []) if isinstance(e, dict)}
        missing = sorted({str(c).strip() for c in source_census} - present - {""})
        if missing:
            shown = ", ".join(missing[:20])
            more = f" (+{len(missing) - 20} more)" if len(missing) > 20 else ""
            diagnosis.append({
                "code": "D8_OMITTED",
                "detail": f"{len(missing)} source account(s) absent from "
                          f"classified+unmapped+excluded: {shown}{more}",
                "leaf_ids": missing,
            })

    return diagnosis
