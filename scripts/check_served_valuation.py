"""Read-only DATA probe for the valuation release (Phase 2.3) — every stored
period's served valuation, cash flow, verdicts and stored alerts, dumped for a
before/after diff across a deploy (owner, 2026-10-01: "show the owner a
per-period table of every valuation figure that moves on production — dry
run, read-only — before any deploy").

Mechanism: the seam of `check_served_periods.py` (imported, not copied): the
REAL `GET /api/period/{id}` handler, in process, with `_require_jwt` constant
and `_supabase.per_user` reduced to a `ReadOnlyClient` that forwards `select`
and refuses every other verb. Nothing is written.

`--dump FILE` — one JSON line per period, FLATTENED to dotted keys:
  valuation.*            the whole served valuation object
  cf.* credit.* piotroski.*   assembled_metrics.{cf, credit, piotroski}
  pl.{net_income_statutory, depreciation, ebitda, core_ebitda, turnover, pretax, tax, interest_expense}
  alerts.<alert_key>.{severity, rule_key, title, body, facts_cited.*}   the STORED alert rows GET serves
  verdict.{cfo_positive, cfo_gt_net_income, fcf_negative_with_capex}    comparisons of served figures
A key that appears or disappears shows as ADDED / REMOVED, never silently.

`--diff BEFORE AFTER [--table] [--require-key KEY]` — per period: every key
MOVED, ADDED, REMOVED; then the ALIAS rows (an old served key against the key
that replaces it, e.g. valuation.cross_checks.dcf.equity_value against
valuation.dcf.equity_value — MOVED when they differ, silent when equal).
Tolerance: MONEY keys move beyond half a cent; every other number (rates,
weights, multiples, factors, scores) moves beyond 5e-7 — a WACC that moves by
one basis point is a move. Exit 0 nothing moved · 1 something moved, or a
period is in one dump only · 2 could not run, nothing to compare, or
`--require-key` found the key on no AFTER period (two dumps of the SAME image
are a vacuous pass: pass `--require-key valuation.dcf.schema`).

Reading rule (the design, section 7): read the diff for piotroski.score and
verdict.* flips, a sign change of cf.cash_from_operating or cf.free_cash_flow,
and every alerts.* row that cites either figure. First run the A/A control:
dump the running image twice and require an empty diff.

Usage on the VPS (section 14; nothing is copied into the running container —
the script is bind-mounted read-only into a throwaway container of the image):
  # BEFORE — production's image
  docker run --rm --env-file /opt/cfo-ai/.env --network cfo-ai_default \
      -v /tmp/dcf:/hosttmp \
      -v /tmp/dcf/check_served_valuation.py:/app/scripts/check_served_valuation.py:ro \
      --entrypoint python3 cfo-ai-backend:latest \
      /app/scripts/check_served_valuation.py --dump /hosttmp/val_before.jsonl
  # AFTER — the CANDIDATE image, built from a staged tree that is NOT /opt/cfo-ai
  #         (docker build -t cfo-ai-backend:candidate-dcf /opt/cfo-ai-candidate-dcf);
  #         never `docker compose run backend` in /opt/cfo-ai: that is production's image
  docker run --rm --env-file /opt/cfo-ai/.env --network cfo-ai_default \
      -v /tmp/dcf:/hosttmp --entrypoint python3 cfo-ai-backend:candidate-dcf \
      /app/scripts/check_served_valuation.py --dump /hosttmp/val_after.jsonl
  python3 check_served_valuation.py --diff val_before.jsonl val_after.jsonl --table \
      --require-key valuation.dcf.schema
  python3 check_served_valuation.py --self-test

It must sit beside `check_served_periods.py` (it imports it from its own
directory): /app/scripts in an image, scripts/ in the repo.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

#: Half a cent — MONEY keys only.
MONEY_TOL = 0.005
#: Everything else served as a number (rates and weights at 4 dp, multiples,
#: discount factors, scores): beyond float noise is a move.
EXACT_TOL = 5e-7

#: The served sections kept whole, as (dotted source path, dump prefix).
SECTIONS: Tuple[Tuple[str, str], ...] = (
    ("valuation", "valuation"),
    ("assembled_metrics.cf", "cf"),
    ("assembled_metrics.credit", "credit"),
    ("assembled_metrics.piotroski", "piotroski"),
)
#: P&L figures the valuation reads, kept by name so the dump stays small.
PL_KEYS: Tuple[str, ...] = ("net_income_statutory", "depreciation", "ebitda", "core_ebitda", "turnover",
                            "pretax", "tax", "interest_expense")
#: What is kept of each stored alert row.
ALERT_KEYS: Tuple[str, ...] = ("severity", "rule_key", "title", "body", "facts_cited")

_RECORD_META = ("period_id", "org_id", "period_end", "status")

#: Last path segments (or whole-key patterns) that carry MONEY.
_MONEY_LAST = re.compile(
    r"^(?:value|fcf|present_value|undiscounted|net_debt|enterprise_value|equity_value|explicit_pv_total|"
    r"base_fcf|stabilized_fcf|net_income|net_profit|depreciation|net_wc_change|cash_from_operating|capex_real|"
    r"free_cash_flow|low|mid|high|asset_based_equity|ebitda\w*|core_ebitda|turnover|pretax|tax|interest_expense|"
    r"\w+_used|\w+_value|\w+_low|\w+_high|ev_p\d+|equity_p\d+|ev_ebitda_p\d+|equity_ebitda_p\d+|"
    r"ev_revenue_equity_p\d+|sensitivity_low|sensitivity_high)$")
_NOT_MONEY_PATH = re.compile(r"(?:^|\.)(?:inputs|wacc_components|multiples|scores?|weights?|composite\w*|"
                             r"letter_grade_bands|altman\w*)(?:\.|\[|$)")


def is_money_key(key: str) -> bool:
    """True when the key's served unit is money (half-cent tolerance)."""
    if key.startswith("cf.") or key.startswith("pl."):
        return True
    if key.startswith("alerts.") or key.startswith("verdict.") or key.startswith("piotroski."):
        return False
    if key.startswith("credit."):
        return key.endswith(".cash.value")
    last = re.sub(r"\[\d+\]$", "", key.rsplit(".", 1)[-1])
    if key.startswith("valuation.inputs.") and last.endswith("_used"):
        return True
    if _NOT_MONEY_PATH.search(key):
        return last in ("total_equity_used", "total_debt_used")
    return bool(_MONEY_LAST.match(last))


def _get(body: Any, dotted: str) -> Any:
    cur = body
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def flatten(value: Any, prefix: str, out: Dict[str, Any]) -> None:
    """Dotted keys for every leaf; lists index by position; refusal / label
    objects flatten too, so a changed sentence is a move as much as a figure."""
    if isinstance(value, dict):
        if not value:
            out[prefix] = {}
            return
        for k in sorted(value):
            flatten(value[k], f"{prefix}.{k}", out)
    elif isinstance(value, list):
        if not value:
            out[prefix] = []
            return
        for i, v in enumerate(value):
            flatten(v, f"{prefix}[{i}]", out)
    else:
        out[prefix] = value


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        return None
    return float(v)


def snapshot(body: Any) -> Dict[str, Any]:
    """The flattened served figures of one body. Reads; the only arithmetic is
    the three `verdict.*` comparisons of served figures."""
    out: Dict[str, Any] = {}
    if not isinstance(body, dict):
        return out
    for src, prefix in SECTIONS:
        val = _get(body, src)
        if val is None:
            out[prefix] = None
        else:
            flatten(val, prefix, out)
    pl = _get(body, "assembled_metrics.pl")
    if isinstance(pl, dict):
        for k in PL_KEYS:
            if k in pl:
                flatten(pl[k], f"pl.{k}", out)
    # Stored alert rows, keyed by alert_key (list order is not stable).
    alerts = body.get("alerts")
    if isinstance(alerts, list):
        seen: Dict[str, int] = {}
        for a in alerts:
            if not isinstance(a, dict):
                continue
            name = str(a.get("alert_key") or a.get("rule_key") or a.get("id") or "alert")
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1:
                name = f"{name}#{seen[name]}"
            for k in ALERT_KEYS:
                if k in a:
                    flatten(a[k], f"alerts.{name}.{k}", out)
    # The conditions the engine's verdicts read (comparisons, not figures).
    cf = _get(body, "assembled_metrics.cf") if isinstance(_get(body, "assembled_metrics.cf"), dict) else {}
    cfo, fcf, capex = _num(cf.get("cash_from_operating")), _num(cf.get("free_cash_flow")), _num(cf.get("capex_real"))
    ni = _num((pl or {}).get("net_income_statutory")) if isinstance(pl, dict) else None
    out["verdict.cfo_positive"] = None if cfo is None else cfo > 0
    out["verdict.cfo_gt_net_income"] = None if cfo is None or ni is None else cfo > ni
    out["verdict.fcf_negative_with_capex"] = None if fcf is None or capex is None else (fcf < 0 and capex < 0)
    return out


def _moved(key: str, a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a != b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(a) and math.isnan(b):
            return False
        return abs(float(a) - float(b)) > (MONEY_TOL if is_money_key(key) else EXACT_TOL)
    return a != b


def _row_value(rec: Dict[str, Any], list_prefix: str, key_field: str, wanted: str, value_field: str) -> Any:
    """The `value_field` of the list item whose `key_field` equals `wanted`."""
    i = 0
    while f"{list_prefix}[{i}].{key_field}" in rec:
        if rec[f"{list_prefix}[{i}].{key_field}"] == wanted:
            return rec.get(f"{list_prefix}[{i}].{value_field}", _ABSENT)
        i += 1
    return _ABSENT


_ABSENT = object()

#: old served key -> how to read the figure that replaces it from an AFTER record.
ALIASES: Dict[str, Any] = {
    "valuation.cross_checks.dcf.wacc": lambda r: r.get("valuation.dcf.inputs.wacc", _ABSENT),
    "valuation.cross_checks.dcf.terminal_growth": lambda r: r.get("valuation.dcf.inputs.terminal_growth", _ABSENT),
    "valuation.cross_checks.dcf.enterprise_value": lambda r: r.get("valuation.dcf.enterprise_value", _ABSENT),
    "valuation.cross_checks.dcf.equity_value": lambda r: r.get("valuation.dcf.equity_value", _ABSENT),
    "valuation.cross_checks.dcf.sensitivity_low": lambda r: _row_value(
        r, "valuation.dcf.scenarios", "key", "conservative", "equity_value"),
    "valuation.cross_checks.dcf.sensitivity_high": lambda r: _row_value(
        r, "valuation.dcf.scenarios", "key", "optimistic", "equity_value"),
    **{f"valuation.fcf_breakdown.{k}": (lambda r, k=k: _row_value(r, "valuation.dcf.cash_flow.rows", "key", k, "value"))
       for k in ("net_income", "depreciation", "net_wc_change", "cash_from_operating", "capex_real", "free_cash_flow")},
    "valuation.fcf_breakdown.stabilized_fcf": lambda r: r.get("valuation.dcf.cash_flow.stabilized_fcf", _ABSENT),
}


def diff_records(before: Dict[str, Dict[str, Any]], after: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Pure core of `--diff`. `before` / `after` map period_id -> dump record."""
    periods_moved: List[Dict[str, Any]] = []
    moved_keys: Dict[str, int] = {}
    only_before = sorted(set(before) - set(after))
    only_after = sorted(set(after) - set(before))
    for pid in sorted(set(before) & set(after)):
        b, a = before[pid], after[pid]
        changes: List[Dict[str, Any]] = []
        for k in sorted(set(b) | set(a)):
            if k in _RECORD_META:
                if k == "status" and b.get(k) != a.get(k):
                    changes.append({"key": k, "before": b.get(k), "after": a.get(k), "kind": "moved"})
                continue
            if k not in b:
                changes.append({"key": k, "before": None, "after": a[k], "kind": "added"})
            elif k not in a:
                changes.append({"key": k, "before": b[k], "after": None, "kind": "removed"})
            elif _moved(k, b[k], a[k]):
                changes.append({"key": k, "before": b[k], "after": a[k], "kind": "moved"})
        # An old key against the key that replaces it.
        for old, reader in ALIASES.items():
            if old not in b:
                continue
            new_val = reader(a)
            if new_val is _ABSENT:
                continue
            if _moved(old, b[old], new_val):
                changes.append({"key": old + " -> its replacement", "before": b[old], "after": new_val,
                                "kind": "alias_moved"})
        for c in changes:
            moved_keys[c["key"]] = moved_keys.get(c["key"], 0) + 1
        if changes:
            periods_moved.append({"period_id": pid, "org_id": a.get("org_id") or b.get("org_id"),
                                  "period_end": a.get("period_end") or b.get("period_end"),
                                  "changes": changes})
    return {
        "compared": len(set(before) & set(after)),
        "only_before": only_before,
        "only_after": only_after,
        "periods_moved": periods_moved,
        "keys_moved": dict(sorted(moved_keys.items(), key=lambda kv: (-kv[1], kv[0]))),
    }


def _fmt(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, float):
        return f"{v:,.4f}" if abs(v) < 10 else f"{v:,.2f}"
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)[:60]
    return str(v)[:80]


_TAG = {"moved": "MOVED  ", "added": "ADDED  ", "removed": "REMOVED", "alias_moved": "ALIAS≠ "}


def render_diff(report: Dict[str, Any], table: bool) -> str:
    lines: List[str] = []
    lines.append(f"SERVED VALUATION DIFF — compared {report['compared']} periods; "
                 f"{len(report['periods_moved'])} moved; "
                 f"{len(report['only_before'])} only before, {len(report['only_after'])} only after")
    for pid in report["only_before"]:
        lines.append(f"  ONLY BEFORE  {pid}")
    for pid in report["only_after"]:
        lines.append(f"  ONLY AFTER   {pid}")
    for p in report["periods_moved"]:
        verdicts = [c for c in p["changes"] if c["key"].startswith(("verdict.", "piotroski.score"))]
        lines.append(f"\n  {p['period_id']}  org {p['org_id']}  {p['period_end']}  ({len(p['changes'])} change(s)"
                     f"{', VERDICT ROWS: ' + str(len(verdicts)) if verdicts else ''})")
        for c in p["changes"]:
            tag = _TAG[c["kind"]]
            if table:
                lines.append(f"    {tag} {c['key']:<62} {_fmt(c['before']):>24}  ->  {_fmt(c['after']):>24}")
            else:
                lines.append(f"    {tag} {c['key']}: {_fmt(c['before'])} -> {_fmt(c['after'])}")
    if report["keys_moved"]:
        lines.append("\n  keys that changed (periods affected):")
        for k, n in report["keys_moved"].items():
            lines.append(f"    {n:>4}  {k}")
    code = exit_for(report)
    verdict = {0: "GREEN — no served figure moved",
               1: f"REVIEW — {len(report['periods_moved'])} period(s) changed"
                  + (f"; {len(report['only_before'])} only before, {len(report['only_after'])} only after"
                     if report["only_before"] or report["only_after"] else "")
                  + "; the owner approves before any switch",
               2: "RED — nothing to compare (vacuous)"}[code]
    lines.append(f"\n  {verdict}")
    return "\n".join(lines)


def _load_dump(path: str) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            out[str(rec["period_id"])] = rec
    return out


def run_dump(dump_path: str, org: Optional[str], limit: Optional[int]) -> int:
    import check_served_periods as CSP  # the one seam, imported

    CSP._add_src_to_path()
    try:
        from engine import boot_verify
    except ImportError:
        boot_verify = None
    if boot_verify is not None and hasattr(boot_verify, "verify_config"):
        try:
            boot_verify.verify_config()
        except Exception as exc:  # noqa: BLE001
            print(f"SERVED VALUATION: RED — this image cannot boot: {exc}")
            return 2
    from engine.api import _supabase

    periods = CSP._list_periods(_supabase.admin, org, limit)
    seen: List[Dict[str, Any]] = []

    def observe(row: Dict[str, Any], status: int, body: Any) -> None:
        rec = {"period_id": row.get("id"), "org_id": row.get("org_id"), "period_end": row.get("period_end"),
               "status": status}
        rec.update(snapshot(body))
        seen.append(rec)

    report = CSP.check_periods(periods, CSP._served_fetch(), observe=observe)
    with open(dump_path, "w", encoding="utf-8") as fh:
        for rec in sorted(seen, key=lambda r: str(r["period_id"])):
            fh.write(json.dumps(rec, sort_keys=True, default=str) + "\n")
    with_val = sum(1 for r in seen if any(k.startswith("valuation.") for k in r))
    no_val = [str(r["period_id"]) for r in seen if "valuation" in r and r["valuation"] is None]
    with_alerts = sum(1 for r in seen if any(k.startswith("alerts.") for k in r))
    print(f"SERVED VALUATION — dumped {len(seen)} periods to {dump_path}: {with_val} with a served valuation, "
          f"{len(no_val)} with valuation null, {with_alerts} with stored alerts, {report['failed']} failed to serve")
    for pid in no_val:
        print(f"  valuation null  {pid}")
    for f in report["failures"]:
        print(f"  RED  {f['period_id']}  org {f['org_id']}  {f['label']}  → {f['problem']}")
    if report["checked"] == 0:
        print("  RED — nothing to dump (vacuous)")
        return 2
    return 1 if report["failed"] else 0


def exit_for(report: Dict[str, Any]) -> int:
    if report["compared"] == 0:
        return 2
    return 1 if (report["periods_moved"] or report["only_before"] or report["only_after"]) else 0


def self_test() -> int:
    meta = {"org_id": "o", "status": 200}
    before = {"p1": {"period_id": "p1", "period_end": "2025-12-31", **meta,
                     "valuation.cross_checks.dcf.equity_value": 100.0, "valuation.cross_checks.dcf.wacc": 0.1322,
                     "valuation.fcf_breakdown.cash_from_operating": 43.0,
                     "cf.cash_from_operating": 50.0, "cf.provision_movement": 7.0, "credit.letter_grade": "A",
                     "alerts.cash_dividends_declared_unpaid.facts_cited.cash_from_operating": 50.0,
                     "verdict.cfo_gt_net_income": True},
              "p2": {"period_id": "p2", "period_end": "2024-12-31", **meta}}
    after = {"p1": {"period_id": "p1", "period_end": "2025-12-31", **meta,
                    "valuation.dcf.schema": "dcf/1", "valuation.dcf.equity_value": 100.004,
                    "valuation.dcf.inputs.wacc": 0.1323,
                    "valuation.dcf.cash_flow.rows[0].key": "cash_from_operating",
                    "valuation.dcf.cash_flow.rows[0].value": 43.0,
                    "cf.cash_from_operating": 43.0, "credit.letter_grade": "A",
                    "alerts.cash_dividends_declared_unpaid.facts_cited.cash_from_operating": 50.0,
                    "verdict.cfo_gt_net_income": False},
             "p3": {"period_id": "p3", "period_end": "2023-12-31", **meta}}
    rep = diff_records(before, after)
    ch = {c["key"]: c["kind"] for c in rep["periods_moved"][0]["changes"]}
    assert rep["compared"] == 1 and rep["only_before"] == ["p2"] and rep["only_after"] == ["p3"], rep
    assert ch["cf.cash_from_operating"] == "moved" and ch["cf.provision_movement"] == "removed", ch
    assert ch["valuation.dcf.schema"] == "added" and ch["verdict.cfo_gt_net_income"] == "moved", ch
    # the alias map: equity equal within half a cent is silent; a one-bp WACC move is not; CFO row equal is silent
    assert "valuation.cross_checks.dcf.equity_value -> its replacement" not in ch, ch
    assert ch["valuation.cross_checks.dcf.wacc -> its replacement"] == "alias_moved", ch
    assert "valuation.fcf_breakdown.cash_from_operating -> its replacement" not in ch, ch
    # a stored alert that still cites the old CFO does NOT move — the reader sees it beside the moved cf figure
    assert "alerts.cash_dividends_declared_unpaid.facts_cited.cash_from_operating" not in ch
    # tolerances: money half a cent; everything else exact
    assert not _moved("valuation.dcf.equity_value", 100.0, 100.004)
    assert _moved("valuation.dcf.equity_value", 100.0, 100.006)
    assert _moved("valuation.dcf.inputs.wacc", 0.1322, 0.1323) and _moved("valuation.cross_checks.dcf.wacc", 0.0875, 0.0920)
    assert _moved("valuation.primary.multiple_p50", 8.0, 8.004) and _moved("credit.altman_z_score", 3.09, 3.094)
    assert _moved("valuation.dcf.years[0].discount_factor", 0.9195, 0.9158)
    assert is_money_key("cf.net_change_in_cash") and is_money_key("valuation.dcf.years[2].fcf")
    assert is_money_key("valuation.inputs.total_debt_used") and not is_money_key("valuation.dcf.inputs.tax_rate")
    assert is_money_key("valuation.football_field[0].mid") and not is_money_key("piotroski.score")
    # snapshot: alerts keyed by alert_key, verdict rows, nulls kept
    body = {"valuation": {"dcf": {"years": [{"year": 1, "fcf": 1.5}], "refusal": None}},
            "assembled_metrics": {"cf": {"cash_from_operating": 1.0, "free_cash_flow": -2.0, "capex_real": -3.0},
                                  "pl": {"net_income_statutory": 2.0, "x": 9}, "credit": None},
            "alerts": [{"alert_key": "k", "severity": "medium", "title": "t", "body": "b",
                        "facts_cited": {"cash_from_operating": 1.0}, "id": "i"},
                       {"alert_key": "k", "title": "second"}]}
    snap = snapshot(body)
    assert snap["valuation.dcf.years[0].fcf"] == 1.5 and snap["valuation.dcf.refusal"] is None, snap
    assert snap["cf.cash_from_operating"] == 1.0 and snap["pl.net_income_statutory"] == 2.0 and "pl.x" not in snap
    assert snap["credit"] is None and snap["piotroski"] is None
    assert snap["alerts.k.facts_cited.cash_from_operating"] == 1.0 and snap["alerts.k#2.title"] == "second"
    assert snap["verdict.cfo_positive"] is True and snap["verdict.cfo_gt_net_income"] is False
    assert snap["verdict.fcf_negative_with_capex"] is True
    # exit codes: a period in one dump only is not green; identical dumps are; nothing to compare is vacuous
    assert exit_for(rep) == 1 and exit_for(diff_records(before, before)) == 0 and exit_for(diff_records({}, {})) == 2
    only = diff_records({"a": {"period_id": "a"}, "b": {"period_id": "b"}}, {"a": {"period_id": "a"}})
    assert not only["periods_moved"] and exit_for(only) == 1
    print("SELF-TEST OK — flatten, alerts by key, verdict rows, alias map, money / exact tolerances, exit codes")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dump", help="write one JSON line per period with every served valuation figure")
    ap.add_argument("--diff", nargs=2, metavar=("BEFORE", "AFTER"), help="compare two dumps")
    ap.add_argument("--require-key", help="with --diff: exit 2 unless at least one AFTER period carries this key "
                                          "(two dumps of the same image are a vacuous pass)")
    ap.add_argument("--table", action="store_true", help="aligned columns in the diff")
    ap.add_argument("--json", action="store_true", help="machine-readable diff report")
    ap.add_argument("--org")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.diff:
        try:
            b, a = _load_dump(args.diff[0]), _load_dump(args.diff[1])
            rep = diff_records(b, a)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            print("SERVED VALUATION DIFF: COULD NOT RUN — treat as RED")
            return 2
        print(json.dumps(rep, indent=1, default=str) if args.json else render_diff(rep, args.table))
        if args.require_key and not any(args.require_key in rec for rec in a.values()):
            print(f"  RED — no AFTER period carries `{args.require_key}`: the AFTER dump is not the candidate image")
            return 2
        return exit_for(rep)
    if args.dump:
        try:
            return run_dump(args.dump, args.org, args.limit)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            print("SERVED VALUATION: COULD NOT RUN — treat as RED")
            return 2
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
