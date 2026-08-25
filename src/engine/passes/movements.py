"""MOVEMENTS (rulaje) intelligence pass — identity checks over the
canonical 10-key trial-balance rows.

JURISDICTION-BLIND BY CONSTRUCTION (N7 discipline): this module is pure
arithmetic over the canonical row shape

    {cont, nume_cont, si_d, si_c, r_d, r_c, st_d, st_c, sf_d, sf_c}

plus a ``pairs_present`` map naming which column pairs the source format
actually carried ({"si", "rl", "rc", "sf"} -> bool). It contains ZERO
account-code literals, zero jurisdiction tokens, and zero
column-semantics guesses of its own — every jurisdiction-shaped datum
(code prefixes to exclude, tolerances, vote thresholds) arrives via the
``params`` bag of a pack-declared check or via the caller.

THE CONVENTION PROBE — the central ambiguity this pass resolves.
The "rc" pair (row keys ``st_d``/``st_c``) is populated from TWO
different source-column families that mean different things:

  * "Total sume"     — cumulative sums INCLUDING the opening balance;
  * "Rulaj cumulat"  — cumulative movements EXCLUDING the opening.

Instead of guessing from headers, the probe votes the identities
document-wide (deterministic majority, the same shape as locale
detection). From a SINGLE snapshot the testable forms are the
net-closing identities (real sources routinely carry a fifth
"preceding movements" pair the 10-key row shape folds into st, so the
per-side structural forms fail on exactly the files that are fine):

  A:  net(si) + net(r)  == net(sf)   (the r pair covers ALL movements
                                      since si — annual files / compact
                                      layouts; fails HONESTLY on a
                                      monthly file whose r is one month)
  B:  net(st) == net(sf)             ("Total sume": st is cumulative
                                      sums INCLUDING the opening, so its
                                      net IS the closing balance)
  C:  net(si) + net(st) == net(sf)   ("Rulaj cumulat": st is cumulative
                                      movements EXCLUDING the opening)

Winner = the qualifying identity with the highest match rate; exact
ties resolve by the fixed preference order B > C > A (the probe exists
to interpret the st pair; A carries no st information — a consistent
annual "Total sume" file matches both A and B and is correctly labeled
B). "mixed" when identities are testable but none qualifies;
"insufficient" when too few rows are testable at all. When the sf pair
was SYNTHESIZED from the si+r identity upstream (compact layouts),
identity A holds by construction and is excluded from the vote
(recorded, not counted). When si, r and st are all present, rates["B"]
additionally carries ``per_side_rate`` — the fraction of rows where
st == si + r holds PER SIDE, which discriminates 4-pair sources (holds)
from 5-pair sources with a folded preceding-movements block (fails).

FINDINGS, NEVER MUTATIONS. The result is a plain additive dict of
M-coded findings; input rows are read-only and byte-identical after the
call:

  M1_PER_ACCOUNT_IDENTITY  per-account closing-consistency violations
                           under the winning convention, exact integer
                           minor units, capped list;
  M2_CROSSFOOT             document-wide movement totals cross-foot
                           (sum debit vs sum credit per movement pair);
  M3_CLOSING_CONSISTENT    document-level aggregate of the winning
                           identity (violations can cancel — a pass here
                           with M1 failures signals misclassification
                           rather than missing value).

Absent pairs => honest "not_applicable" — never a guessed verdict.

MONEY DISCIPLINE: integer minor units end-to-end. Row floats convert via
``decimal.Decimal(repr(x))`` (exact for the float's shortest repr); a
value that is not exactly representable in minor units is rounded
half-even and flagged in ``subcent_rounded_rows`` instead of silently
absorbed. Floats appear only in the serialized rates/ratios.

IMPORT DISCIPLINE: module-level imports are STDLIB ONLY, so
``engine.packs.schema`` can lazy-load this file by path (the
``_reconciliation_checks_module`` pattern) without breaking the
engine.packs import-leaf property. The CHECK_IMPLS registration at the
bottom lazy-imports the registry inside the function and is idempotent,
so package import and by-path load coexist.
"""
from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

SCHEMA = "movement_checks_v1"

#: The impl id packs reference from checks.yaml (`impl:` field).
CHECK_IMPL_ID = "builtin.movement_identities"

#: pair key -> (debit row key, credit row key). Mirrors the canonical
#: row contract; "rl" = period movements, "rc" = the ambiguous
#: cumulative pair the convention probe exists to interpret.
PAIR_KEYS: Tuple[Tuple[str, str, str], ...] = (
    ("si", "si_d", "si_c"),
    ("rl", "r_d", "r_c"),
    ("rc", "st_d", "st_c"),
    ("sf", "sf_d", "sf_c"),
)

_CONVENTIONS = ("A", "B", "C")

#: Engine defaults — every one overridable via the pack check's params.
_DEFAULTS: Dict[str, Any] = {
    "convention_min_rate": 0.98,   # a convention must match >= this rate
    "min_applicable_rows": 3,      # fewer testable rows => insufficient
    "violation_cap": 20,           # M1 lists at most this many accounts
    "identity_tolerance_minor": 0, # per-row identity slack, minor units
    "crossfoot_tolerance_minor": 0,  # M2 doc-level slack, minor units
    "exclude_code_prefixes": (),   # jurisdiction data (e.g. off-balance
                                   # memo classes) — NEVER defaulted here
}

_HUNDRED = Decimal(100)
_CENT = Decimal("1")


def _to_minor(value: Any) -> Tuple[int, bool]:
    """Exact minor units for a row value. Returns (minor_units, exact).

    ``Decimal(repr(x))`` reproduces the float's shortest decimal exactly;
    scaling by 100 is exact whenever the source carried <= 2 decimals
    (the overwhelmingly common case). Anything finer is rounded half-even
    and reported as inexact so callers can surface it instead of guessing.
    """
    if value is None:
        return 0, True
    if isinstance(value, int) and not isinstance(value, bool):
        return value * 100, True
    try:
        d = Decimal(repr(float(value))) * _HUNDRED
    except (ValueError, TypeError, ArithmeticError):
        return 0, True
    q = d.to_integral_value(rounding=ROUND_HALF_EVEN)
    return int(q), q == d


class _Row(object):
    """Read-only integer-minor view of one canonical row."""

    __slots__ = ("code", "minor", "inexact")

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.code = str(raw.get("cont") or "").strip()
        self.minor: Dict[str, int] = {}
        self.inexact = False
        for _, dk, ck in PAIR_KEYS:
            for key in (dk, ck):
                m, exact = _to_minor(raw.get(key))
                self.minor[key] = m
                if not exact:
                    self.inexact = True

    def net(self, dk: str, ck: str) -> int:
        return self.minor[dk] - self.minor[ck]


def _params_with_defaults(params: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    out = dict(_DEFAULTS)
    for key, value in (params or {}).items():
        if key in out:
            out[key] = value
    return out


def _identity_delta(row: _Row, convention: str) -> int:
    """Net-closing identity delta (minor units) for a row under a
    convention. 0 == the identity holds exactly.

    A: net(si) + net(r)  - net(sf)
    B: net(st)           - net(sf)   ("Total sume" includes opening)
    C: net(si) + net(st) - net(sf)   ("Rulaj cumulat" excludes opening)
    """
    if convention == "A":
        return (
            row.net("si_d", "si_c") + row.net("r_d", "r_c")
            - row.net("sf_d", "sf_c")
        )
    if convention == "B":
        return row.net("st_d", "st_c") - row.net("sf_d", "sf_c")
    if convention == "C":
        return (
            row.net("si_d", "si_c") + row.net("st_d", "st_c")
            - row.net("sf_d", "sf_c")
        )
    raise ValueError("unknown convention %r" % (convention,))


#: convention -> the pair keys it needs present.
_CONVENTION_REQUIRES: Dict[str, Tuple[str, ...]] = {
    "A": ("si", "rl", "sf"),
    "B": ("rc", "sf"),
    "C": ("si", "rc", "sf"),
}

#: convention -> row keys whose values make a row "informative" for the
#: vote (all-zero rows match every identity vacuously and dilute it).
_CONVENTION_VALUE_KEYS: Dict[str, Tuple[str, ...]] = {
    "A": ("si_d", "si_c", "r_d", "r_c", "sf_d", "sf_c"),
    "B": ("st_d", "st_c", "sf_d", "sf_c"),
    "C": ("si_d", "si_c", "st_d", "st_c", "sf_d", "sf_c"),
}

#: Exact-tie preference: interpret the st pair when possible (see the
#: module docstring). Deterministic and documented, never data-driven.
_TIE_PREFERENCE: Tuple[str, ...] = ("B", "C", "A")

#: M1/M3 verify the same net-closing delta as the winning identity.
_closing_delta = _identity_delta

_CLOSING_REQUIRES: Dict[str, Tuple[str, ...]] = dict(_CONVENTION_REQUIRES)


def _normalize_pairs_present(
    pairs_present: Optional[Mapping[str, Any]],
    rows: List[_Row],
) -> Dict[str, bool]:
    if pairs_present is not None:
        return {key: bool(pairs_present.get(key)) for key, _, _ in PAIR_KEYS}
    # Fallback inference (documented heuristic): a pair is "present" when
    # any row carries a nonzero value in it. All-zero-but-present columns
    # are indistinguishable from absent ones in this mode.
    out: Dict[str, bool] = {}
    for key, dk, ck in PAIR_KEYS:
        out[key] = any(r.minor[dk] or r.minor[ck] for r in rows)
    return out


def compute_movement_checks(
    tb_rows: Iterable[Mapping[str, Any]],
    pairs_present: Optional[Mapping[str, Any]] = None,
    *,
    layout_hint: Any = None,
    params: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Run the convention probe + M-coded identity findings.

    ``tb_rows``       — canonical 10-key row dicts (read-only; never
                        mutated).
    ``pairs_present`` — {"si"|"rl"|"rc"|"sf": bool} from the parse
                        metadata; None => inferred from nonzero values.
    ``layout_hint``   — opaque annotation (str, or a dict; a dict key
                        ``synthesized_sf: True`` marks the sf pair as
                        derived from the si+r identity, which makes
                        identity A circular and excludes it from the
                        vote). Recorded verbatim; never branches
                        semantics beyond that one honesty flag.
    ``params``        — pack-declared configuration (tolerances, vote
                        thresholds, jurisdiction code-prefix exclusions).
    """
    cfg = _params_with_defaults(params)
    exclude_prefixes = tuple(
        str(p) for p in (cfg["exclude_code_prefixes"] or ())
    )
    cap = int(cfg["violation_cap"])
    tol = int(cfg["identity_tolerance_minor"])
    xtol = int(cfg["crossfoot_tolerance_minor"])
    min_rows = int(cfg["min_applicable_rows"])
    min_rate = float(cfg["convention_min_rate"])

    synthesized_sf = bool(
        isinstance(layout_hint, Mapping) and layout_hint.get("synthesized_sf")
    )

    all_rows = [
        _Row(r) for r in tb_rows
        if isinstance(r, Mapping) and str(r.get("cont") or "").strip()
    ]
    rows = [
        r for r in all_rows
        if not (exclude_prefixes and r.code.startswith(exclude_prefixes))
    ]
    excluded_count = len(all_rows) - len(rows)
    subcent_rounded = [r.code for r in rows if r.inexact]

    present = _normalize_pairs_present(pairs_present, rows)

    # ── convention probe ────────────────────────────────────────────
    rates: Dict[str, Dict[str, Any]] = {}
    qualifying: List[Tuple[float, str]] = []
    for conv in _CONVENTIONS:
        needs = _CONVENTION_REQUIRES[conv]
        # sf synthesized upstream FROM si+r makes exactly identity A
        # circular; B/C still test st against the synthesized closing
        # meaningfully (st is independent of the synthesis inputs' sum
        # only through the same bookkeeping, so they stay informative).
        by_construction = synthesized_sf and conv == "A"
        if not all(present.get(k) for k in needs):
            rates[conv] = {
                "applicable": 0, "matches": 0, "rate": None,
                "testable": False,
            }
            continue
        value_keys = _CONVENTION_VALUE_KEYS[conv]
        applicable = [
            r for r in rows if any(r.minor[k] for k in value_keys)
        ]
        matches = sum(
            1 for r in applicable if abs(_identity_delta(r, conv)) <= tol
        )
        rate = (matches / len(applicable)) if applicable else None
        entry: Dict[str, Any] = {
            "applicable": len(applicable),
            "matches": matches,
            "rate": rate,
            "testable": True,
        }
        if by_construction:
            entry["by_construction"] = True
        if conv == "B" and all(present.get(k) for k in ("si", "rl", "rc")):
            # Structural sub-rate: st == si + r PER SIDE. Discriminates
            # 4-pair sources (holds) from 5-pair sources whose preceding
            # movements were folded into st (fails) — diagnostic only.
            per_side_matches = sum(
                1 for r in applicable
                if r.minor["st_d"] == r.minor["si_d"] + r.minor["r_d"]
                and r.minor["st_c"] == r.minor["si_c"] + r.minor["r_c"]
            )
            entry["per_side_rate"] = (
                (per_side_matches / len(applicable)) if applicable else None
            )
        rates[conv] = entry
        if (
            not by_construction
            and len(applicable) >= min_rows
            and rate is not None
            and rate >= min_rate
        ):
            qualifying.append((rate, conv))

    tie_note: Optional[str] = None
    if qualifying:
        best_rate = max(rate for rate, _ in qualifying)
        tied = [conv for rate, conv in qualifying if rate == best_rate]
        winners = sorted(tied, key=_TIE_PREFERENCE.index)
        winner = winners[0]  # deterministic: fixed preference B > C > A
        if len(winners) > 1:
            tie_note = (
                "identities %s matched at the same rate; %r is reported "
                "under the fixed preference order %s"
                % (sorted(winners), winner, list(_TIE_PREFERENCE))
            )
    else:
        any_testable = any(
            e.get("testable") and not e.get("by_construction")
            and e["applicable"] >= min_rows
            for e in rates.values()
        )
        winner = "mixed" if any_testable else "insufficient"

    convention: Dict[str, Any] = {"winner": winner, "rates": rates}
    if tie_note:
        convention["tie_note"] = tie_note
    if synthesized_sf:
        convention["sf_synthesized_from_identity"] = True

    # ── findings ────────────────────────────────────────────────────
    findings: List[Dict[str, Any]] = []

    # M1 — per-account closing consistency under the winning convention.
    if winner in _CONVENTIONS and all(
        present.get(k) for k in _CLOSING_REQUIRES[winner]
    ) and not (synthesized_sf and winner == "A"):
        violations: List[Dict[str, Any]] = []
        total = 0
        for r in rows:
            delta = _closing_delta(r, winner)
            if abs(delta) > tol:
                total += 1
                if len(violations) < cap:
                    violations.append({
                        "cont": r.code,
                        "delta_minor": delta,
                        "net_sf_minor": r.net("sf_d", "sf_c"),
                    })
        findings.append({
            "code": "M1_PER_ACCOUNT_IDENTITY",
            "status": "pass" if total == 0 else "fail",
            "convention": winner,
            "violations_total": total,
            "violations": violations,
            "violations_truncated": total > len(violations),
        })
    else:
        findings.append({
            "code": "M1_PER_ACCOUNT_IDENTITY",
            "status": "not_applicable",
            "detail": (
                "sf synthesized from the si+r identity — the check would "
                "be circular"
                if winner == "A" and synthesized_sf
                else "no determinate convention or required pairs absent"
            ),
        })

    # M2 — movement totals cross-foot (sum D vs sum C per movement pair).
    crossfoot_entries: List[Dict[str, Any]] = []
    for key, dk, ck in PAIR_KEYS:
        if key not in ("rl", "rc") or not present.get(key):
            continue
        sum_d = sum(r.minor[dk] for r in rows)
        sum_c = sum(r.minor[ck] for r in rows)
        delta = sum_d - sum_c
        crossfoot_entries.append({
            "pair": key,
            "sum_debit_minor": sum_d,
            "sum_credit_minor": sum_c,
            "delta_minor": delta,
            "status": "pass" if abs(delta) <= xtol else "fail",
        })
    if crossfoot_entries:
        overall = (
            "pass"
            if all(e["status"] == "pass" for e in crossfoot_entries)
            else "fail"
        )
        findings.append({
            "code": "M2_CROSSFOOT",
            "status": overall,
            "pairs": crossfoot_entries,
        })
    else:
        findings.append({
            "code": "M2_CROSSFOOT",
            "status": "not_applicable",
            "detail": "no movement pair present",
        })

    # M3 — document-level closing consistency under the winner.
    if winner in _CONVENTIONS and all(
        present.get(k) for k in _CLOSING_REQUIRES[winner]
    ) and not (synthesized_sf and winner == "A"):
        agg = sum(_closing_delta(r, winner) for r in rows)
        findings.append({
            "code": "M3_CLOSING_CONSISTENT",
            "status": "pass" if abs(agg) <= xtol else "fail",
            "convention": winner,
            "aggregate_delta_minor": agg,
        })
    else:
        findings.append({
            "code": "M3_CLOSING_CONSISTENT",
            "status": "not_applicable",
            "detail": (
                "sf synthesized from the si+r identity — the check would "
                "be circular"
                if winner == "A" and synthesized_sf
                else "no determinate convention or required pairs absent"
            ),
        })

    # ── M5_MOVEMENT_EFFECT — impossible-bookkeeping detector (added
    # 2026-08-25 after the adversarial wave's construction C escape:
    # both AI framings binding the closing pair to the OPENING columns
    # made every identity check circular, yet the document then claims
    # nonzero movements that changed NO closing balance — double-entry
    # movements that move nothing are not bookkeeping). Applicable when
    # the si, sf AND a movement pair are all present with nonzero
    # movements; FAILS iff every row's signed closing equals its signed
    # opening. Exact integer minor units; a finding, never a mutation.
    if present.get("si") and present.get("sf") and present.get("rl"):
        total_movement = 0
        any_effect = False
        applicable_rows = 0
        for r in rows:
            total_movement += abs(r.minor["r_d"]) + abs(r.minor["r_c"])
            si_signed = r.net("si_d", "si_c")
            sf_signed = r.net("sf_d", "sf_c")
            applicable_rows += 1
            if sf_signed != si_signed:
                any_effect = True
        if total_movement > 0 and applicable_rows:
            findings.append({
                "code": "M5_MOVEMENT_EFFECT",
                "status": "pass" if any_effect else "fail",
                "detail": (
                    "movements move at least one closing balance"
                    if any_effect else
                    "nonzero movements (%d minor units) changed NO closing "
                    "balance on any of %d rows — impossible double-entry; "
                    "the closing pair is likely misbound (e.g. to the "
                    "opening columns)" % (total_movement, applicable_rows)
                ),
            })
        else:
            findings.append({
                "code": "M5_MOVEMENT_EFFECT",
                "status": "not_applicable",
                "detail": "no nonzero movement pair to test",
            })

    # ── raw class-level signals (neutral: grouped by the code's first
    # character; interpretation is pack territory) ──────────────────
    movement_pair = (
        ("r_d", "r_c") if present.get("rl")
        else (("st_d", "st_c") if present.get("rc") else None)
    )
    class_signals: List[Dict[str, Any]] = []
    if movement_pair is not None:
        grouped: Dict[str, Dict[str, int]] = {}
        for r in rows:
            g = grouped.setdefault(r.code[:1], {
                "movement_debit_minor": 0, "movement_credit_minor": 0,
                "closing_debit_minor": 0, "closing_credit_minor": 0,
            })
            g["movement_debit_minor"] += r.minor[movement_pair[0]]
            g["movement_credit_minor"] += r.minor[movement_pair[1]]
            g["closing_debit_minor"] += r.minor["sf_d"]
            g["closing_credit_minor"] += r.minor["sf_c"]
        for cls in sorted(grouped):
            g = grouped[cls]
            movement_abs = abs(g["movement_debit_minor"]) + abs(g["movement_credit_minor"])
            closing_abs = abs(g["closing_debit_minor"]) + abs(g["closing_credit_minor"])
            class_signals.append({
                "class": cls,
                **g,
                "movement_to_closing_ratio": (
                    (movement_abs / closing_abs) if closing_abs else None
                ),
            })

    return {
        "schema": SCHEMA,
        "layout_hint": (
            dict(layout_hint) if isinstance(layout_hint, Mapping)
            else layout_hint
        ),
        "pairs_present": present,
        "rows_considered": len(rows),
        "rows_excluded_by_prefix": excluded_count,
        "subcent_rounded_rows": subcent_rounded,
        "convention": convention,
        "findings": findings,
        "class_signals": class_signals,
    }


def movement_checks_pass(result: Optional[Mapping[str, Any]]) -> Optional[bool]:
    """Tri-state verdict for the determinism/health harness leg:

    ``None``  — nothing was decidable (insufficient data, or every
                finding was not_applicable);
    ``False`` — at least one finding failed;
    ``True``  — at least one finding ran and none failed.
    """
    if not isinstance(result, Mapping):
        return None
    findings = result.get("findings")
    if not isinstance(findings, list) or not findings:
        return None
    statuses = [
        f.get("status") for f in findings if isinstance(f, Mapping)
    ]
    if any(s == "fail" for s in statuses):
        return False
    # CONVENTION DECISIVENESS (hardened 2026-08-25 after the adversarial
    # wave): a "mixed" winner means identities were TESTABLE but none
    # held — e.g. a swapped closing pair drives every identity rate to 0
    # while the swap-invariant M2 crossfoot still passes. A pass carried
    # by M2 alone over an indecisive convention is exactly the correlated
    # column-misread escape; refuse it.
    convention = result.get("convention")
    if isinstance(convention, Mapping) and convention.get("winner") == "mixed":
        return False
    if any(s == "pass" for s in statuses):
        return True
    return None


def run_movement_checks(
    tb_rows: Iterable[Mapping[str, Any]],
    pairs_present: Optional[Mapping[str, Any]] = None,
    *,
    layout_hint: Any = None,
    params: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """CHECK_IMPLS entry point — the callable packs bind via
    ``impl: builtin.movement_identities`` in checks.yaml. The pack's
    ``params`` bag carries every tolerance/threshold/prefix; the engine
    supplies only arithmetic."""
    return compute_movement_checks(
        tb_rows, pairs_present, layout_hint=layout_hint, params=params,
    )


def register_movement_check_impl() -> None:
    """Idempotently register ``builtin.movement_identities``.

    Lazy import keeps this module's top-level stdlib-only (so
    engine.packs.schema can by-path-load it later without pulling
    sibling engine packages). Idempotent so package import and a future
    by-path load in schema.py coexist without a double-registration
    PackError."""
    from engine.packs import schema as _schema

    if CHECK_IMPL_ID not in _schema.CHECK_IMPLS:
        _schema.register_check_impl(CHECK_IMPL_ID, run_movement_checks)


register_movement_check_impl()
