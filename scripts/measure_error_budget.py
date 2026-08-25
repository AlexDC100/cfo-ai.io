#!/usr/bin/env python3
"""Silent-error-rate gate (Part E error budget, battery gate "error-budget").

DEFINITION (printed on every run, and written into
docs/engine_book/error_budget.md):

    silent error rate = wrongly served numeric fields carrying NO
    review flag / total numeric fields served, per lane
    (deterministic | mechanical_mapped | llm).

A field that is wrong but FLAGGED (the served object carries
``needs_review``) counts as the system WORKING — the flag is the
product's honesty mechanism; only an unflagged wrong number is a silent
error.

MEASUREMENT SOURCES

  (a) CORPUS GOLDENS — for every corpus case the replay harness's own
      machinery (imported from scripts/corpus_replay.py, never a
      mirror) re-runs the full offline pipeline in-process and EVERY
      numeric field of the served canonical_bs (row amounts, section
      subtotals, totals, difference, source-anchor pairs — every
      numeric leaf) is compared against the verified-frozen label in
      expected/served_envelope.json. Classification is measured the
      same way against expected/classification.json (every scalar
      leaf = one classification decision).

  (b) FIXTURE ANCHORS — files/ground_truth/verified_anchors_v1.json
      (hand-verified board-report values incl. the 121 closings)
      against LIVE runs of RomaniaPack.run_deterministic_tb over the
      local files/*.xlsx fixtures. Totals/net_result are read through
      FactsGateway accessors ONLY (the import-boundary discipline);
      account-level anchors resolve against served canonical_bs rows —
      and only where the row's granularity matches the anchor's
      (single account code, and either the row IS the anchor's whole
      account group or its leaf set is exactly the anchor's analytic).
      Anchors finer than the served rows, and P&L-movement anchors
      (class 6/7 — not on a balance sheet), are reported
      NOT COMPARABLE, never guessed. files/ is gitignored: where the
      labels file is absent (CI, fresh clones) the anchor half degrades
      to a loud notice and the corpus half stays fully strict.

STATISTICAL HONESTY — Wilson score interval (stdlib
statistics.NormalDist, no scipy/numpy), 95%, per lane. A lane whose N
cannot bound the budget even with zero mismatches prints
"N INSUFFICIENT to certify" and NEVER claims the target met.

GATE RULE (E5): exit 1 iff any SILENT mismatch exists on the labeled
set, OR a lane with sufficient N exceeds its budget. Exit 0 otherwise
(including honest-insufficient lanes). Exit 2 = internal error.

REPRODUCIBLE: the report carries no timestamps and iterates in sorted
order — two consecutive runs produce byte-identical output. The report
is written atomically to data/obs/error_budget_last.json
(ENGINE_OBS_DIR moves the directory, ENGINE_ERROR_BUDGET_LOG points at
an explicit file) for the ops surface.

Usage:
  .venv/bin/python scripts/measure_error_budget.py
      [--case ID ...] [--corpus-root P] [--skip-anchors]
      [--labels P] [--json] [--no-record]

Python 3.9-compatible, stdlib math only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path
from statistics import NormalDist
from typing import Any, Dict, List, Optional, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

import corpus_replay as cr  # noqa: E402 — THE replay machinery, not a mirror

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack  # noqa: E402
from engine.serving import FactsGateway  # noqa: E402

# ── ERROR BUDGETS — DO NOT WIDEN ───────────────────────────────────────
# The silent-error budgets this gate enforces. Widening either number is
# a product decision that must be recorded in
# docs/engine_book/error_budget.md with the operator's sign-off — it is
# NEVER the fix for a red gate (the fix is finding the wrong number or
# flagging it honestly). Same discipline as scripts/measure_bs_drift.py
# and scripts/measure_cross_path.py.
EXTRACTION_BUDGET = 0.0001  # 0.01% silent errors per extraction lane
CLASSIFICATION_BUDGET = 0.0005  # 0.05% on classification decisions

# ── ANCHOR TOLERANCES — DO NOT WIDEN ───────────────────────────────────
# An anchor label carries its own precision: board-report values rounded
# to whole RON compare within half a RON; cent-exact labels compare
# within half a cent. Neither is slack for the engine — both are the
# label's OWN resolution.
ANCHOR_TOL_CENT_RON = 0.005
ANCHOR_TOL_WHOLE_RON = 0.5

DEFINITION = (
    "silent error rate = wrongly served numeric fields carrying NO review "
    "flag / total numeric fields served, per lane (deterministic | "
    "mechanical_mapped | llm); a flagged field counts as the system working"
)

EXTRACTION_LANES = ("deterministic", "mechanical_mapped", "llm")
ALL_LANES = EXTRACTION_LANES + ("classification",)

DEFAULT_LABELS = REPO / "files" / "ground_truth" / "verified_anchors_v1.json"

#: How many mismatch details each lane keeps in the JSON record.
DETAIL_LIMIT = 20

_MISSING = object()

Z95 = NormalDist().inv_cdf(0.975)


# ── statistics (stdlib only, py3.9-safe) ───────────────────────────────


def wilson(mismatches: int, n: int) -> Tuple[Optional[float], Optional[float]]:
    """95% Wilson score interval for a proportion; (None, None) on n=0."""
    if n <= 0:
        return (None, None)
    p = mismatches / float(n)
    z2 = Z95 * Z95
    denom = 1.0 + z2 / n
    center = (p + z2 / (2.0 * n)) / denom
    half = Z95 * math.sqrt(p * (1.0 - p) / n + z2 / (4.0 * n * n)) / denom
    # k=0 / k=n hit exact bounds by definition; avoid float dust there.
    low = 0.0 if mismatches == 0 else max(0.0, center - half)
    high = 1.0 if mismatches == n else min(1.0, center + half)
    return (low, high)


def sufficient_n(budget: float) -> int:
    """The smallest N whose zero-mismatch Wilson upper bound certifies
    the budget: solve z²/(n+z²) ≤ b  ⇒  n ≥ z²(1−b)/b."""
    z2 = Z95 * Z95
    return int(math.ceil(z2 * (1.0 - budget) / budget))


# ── leaf comparison (labeled golden drives the walk) ───────────────────


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def compare_leaves(
    golden: Any,
    actual: Any,
    *,
    numeric_only: bool,
    path: str = "$",
    fields: Optional[List[int]] = None,
    mismatches: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[int, List[Dict[str, Any]]]:
    """Walk the GOLDEN structure (the labels); count every compared leaf
    and record every mismatch with its JSON path. The denominator is the
    labeled set — actual-only extras are not labels and are not counted
    (a structural addition breaks the corpus byte gate anyway)."""
    if fields is None:
        fields = [0]
    if mismatches is None:
        mismatches = []
    if isinstance(golden, dict):
        for k in sorted(golden):
            sub = actual.get(k, _MISSING) if isinstance(actual, dict) else _MISSING
            compare_leaves(
                golden[k], sub, numeric_only=numeric_only,
                path="%s.%s" % (path, k), fields=fields, mismatches=mismatches,
            )
        return fields[0], mismatches
    if isinstance(golden, list):
        for i, item in enumerate(golden):
            sub = (
                actual[i]
                if isinstance(actual, list) and i < len(actual)
                else _MISSING
            )
            compare_leaves(
                item, sub, numeric_only=numeric_only,
                path="%s[%d]" % (path, i), fields=fields, mismatches=mismatches,
            )
        return fields[0], mismatches
    # Scalar leaf.
    if numeric_only and not _is_number(golden):
        return fields[0], mismatches
    fields[0] += 1
    ok = (
        actual is not _MISSING
        and not (isinstance(actual, bool) and not isinstance(golden, bool))
        and not (isinstance(golden, bool) and not isinstance(actual, bool))
        and golden == actual
    )
    if not ok:
        mismatches.append({
            "path": path,
            "expected": golden,
            "actual": "<missing>" if actual is _MISSING else actual,
        })
    return fields[0], mismatches


# ── serve seam (module-level so tests can plant corruptions) ───────────


def _serve(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return cr._reconcile.served_canonical_bs(envelope)


# ── corpus half ────────────────────────────────────────────────────────


def _lane_for_parser(expected_parser: str) -> Optional[str]:
    if expected_parser in cr.DETERMINISTIC_PARSERS:
        return "deterministic"
    if expected_parser in ("ro_llm_fallback", "hu_ai_lane"):
        return "llm"
    return None


def _run_corpus_case(case_dir: Path) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """Re-run one corpus case through corpus_replay's OWN lane runners
    (inside its no-live-API guard) and serve. Returns
    (lane, served_actual, classification_actual). Raises cr.CaseFailure
    on setup problems."""
    meta = cr._load_meta(case_dir)
    input_path = cr._input_path(case_dir)
    content = input_path.read_bytes()
    expected_parser = str(meta["expected_parser"])
    lane = _lane_for_parser(expected_parser)
    if lane is None:
        raise cr.CaseFailure(
            "expected_parser %r has no lane runner here" % expected_parser
        )
    with cr.no_live_api_guard():
        if lane == "deterministic":
            _extraction, classification, envelope, _cur = cr._run_deterministic(
                case_dir.name, meta, input_path, content
            )
        elif expected_parser == "ro_llm_fallback":
            _extraction, classification, envelope, _cur = cr._run_ro_llm_fallback(
                case_dir.name, meta, input_path, content
            )
        else:
            _extraction, classification, envelope, _cur = cr._run_hu_ai_lane(
                case_dir.name, meta, input_path, content
            )
        served = _serve(envelope)
    if not isinstance(served, dict):
        raise cr.CaseFailure("served_canonical_bs returned no object")
    return lane, served, classification


# ── anchor half ────────────────────────────────────────────────────────

_ANCHOR_CODE_RE = re.compile(r"_(\d{3,6})$")


def _anchor_cents(value: float) -> Tuple[int, int]:
    """(expected cents, tolerance in cents) — whole-RON labels get the
    half-RON tolerance of their own precision, cent labels half a cent."""
    integral = float(value) == float(int(value))
    return int(round(float(value) * 100)), (50 if integral else 0)


def _anchor_amount_tol(value: float) -> float:
    integral = float(value) == float(int(value))
    return ANCHOR_TOL_WHOLE_RON if integral else ANCHOR_TOL_CENT_RON


def _compare_fixture_anchors(
    name: str, fx: Dict[str, Any]
) -> Dict[str, Any]:
    """Run one labeled fixture live and compare its anchors. Returns the
    per-fixture detail dict; counting into the deterministic lane is the
    caller's job (fields/mismatches are in the detail)."""
    detail: Dict[str, Any] = {
        "status": "compared",
        "fields_compared": 0,
        "mismatches": [],
        "flagged": False,
        "not_comparable": [],
    }
    path = REPO / str(fx.get("file", ""))
    if not path.is_file():
        detail["status"] = "skipped_missing_file"
        return detail
    content = path.read_bytes()
    import hashlib

    if hashlib.sha256(content).hexdigest() != str(fx.get("sha256", "")):
        detail["status"] = "skipped_sha256_mismatch"
        return detail

    pack = get_pack("RO")
    try:
        _tb, _shaped, assembled = pack.run_deterministic_tb(content, path.name)
    except Exception as exc:  # noqa: BLE001 — a refusal is a FLAG, not silence
        detail["status"] = "refused_by_deterministic_lane"
        detail["refusal"] = "%s (a refusal is a flag, not a silent serve: 0 fields served)" % type(exc).__name__
        return detail

    envelope = assembled["assembled_canonical_v1"]
    served = _serve(envelope)
    if not isinstance(served, dict):
        detail["status"] = "serve_failed"
        return detail
    detail["flagged"] = bool(served.get("needs_review"))
    rows = served.get("rows") or []
    pairs = (served.get("source_anchor") or {}).get("pairs") or {}
    gateway = FactsGateway.from_envelope(envelope, currency="RON")

    def _count(anchor_key: str, expected: Any, actual: Any, tol: float) -> None:
        detail["fields_compared"] += 1
        try:
            ok = abs(float(actual) - float(expected)) <= tol
        except (TypeError, ValueError):
            ok = False
        if not ok:
            detail["mismatches"].append({
                "path": "%s:%s" % (name, anchor_key),
                "expected": expected,
                "actual": actual,
            })

    for key in sorted(fx.get("anchors") or {}):
        value = fx["anchors"][key]
        if key == "net_profit_121_closing":
            if gateway is None:
                detail["not_comparable"].append(
                    {"key": key, "reason": "facts gateway unavailable"}
                )
                continue
            expected_cents, tol_cents = _anchor_cents(value)
            _count(key, expected_cents, gateway.net_result().amount_minor, tol_cents)
            continue
        if key.startswith("totals_row_"):
            pair = pairs.get(key[len("totals_row_"):])
            if not isinstance(pair, dict):
                detail["not_comparable"].append(
                    {"key": key, "reason": "no source totals-row pair served"}
                )
                continue
            tol = _anchor_amount_tol(value)
            _count(key + ".debit", value, pair.get("extracted_debit"), tol)
            _count(key + ".credit", value, pair.get("extracted_credit"), tol)
            continue
        m = _ANCHOR_CODE_RE.search(key)
        if not m:
            detail["not_comparable"].append(
                {"key": key, "reason": "no account code in anchor key"}
            )
            continue
        code = m.group(1)
        if code[0] in ("6", "7"):
            detail["not_comparable"].append({
                "key": key,
                "reason": "P&L movement anchor — outside the served "
                          "balance-sheet surface",
            })
            continue
        matching = [
            r for r in rows
            if len(r.get("account_codes") or []) == 1
            and (
                code == (r["account_codes"][0])
                or code.startswith(r["account_codes"][0])
                or r["account_codes"][0].startswith(code)
            )
        ]
        if len(matching) != 1:
            detail["not_comparable"].append({
                "key": key,
                "reason": "no unique single-code served row for account %s" % code,
            })
            continue
        row = matching[0]
        row_code = row["account_codes"][0]
        leaf_ids = [str(x) for x in (row.get("leaf_ids") or [])]
        whole_group = code == row_code
        exact_analytic = leaf_ids == [code]
        if not (whole_group or exact_analytic):
            detail["not_comparable"].append({
                "key": key,
                "reason": "served row %s aggregates %d leaves — finer than "
                          "the anchor's account %s" % (row.get("id"), len(leaf_ids), code),
            })
            continue
        _count(key, value, row.get("amount"), _anchor_amount_tol(value))
    return detail


# ── measurement ────────────────────────────────────────────────────────


def _empty_lane(budget: float) -> Dict[str, Any]:
    return {
        "budget": budget,
        "n": 0,
        "silent_mismatches": 0,
        "flagged_mismatches": 0,
        "silent": [],
        "flagged": [],
    }


def _tally(lane: Dict[str, Any], n: int, mismatches: List[Dict[str, Any]],
           flagged_doc: bool, case_id: str, artifact: str) -> None:
    lane["n"] += n
    bucket = "flagged" if flagged_doc else "silent"
    for mm in mismatches:
        lane["%s_mismatches" % bucket] += 1
        if len(lane[bucket]) < DETAIL_LIMIT:
            entry = dict(mm)
            entry["case"] = case_id
            entry["artifact"] = artifact
            lane[bucket].append(entry)


def _finalize_lane(lane: Dict[str, Any]) -> None:
    n = lane["n"]
    silent = lane["silent_mismatches"]
    lane["rate"] = (silent / float(n)) if n else None
    low, high = wilson(silent, n)
    lane["ci_low"] = low
    lane["ci_high"] = high
    lane["sufficient_n"] = sufficient_n(lane["budget"])
    lane["sufficient"] = n >= lane["sufficient_n"]


def measure(
    corpus_root: Path = cr.DEFAULT_CORPUS,
    case_ids: Optional[List[str]] = None,
    include_anchors: bool = True,
    labels_path: Path = DEFAULT_LABELS,
) -> Dict[str, Any]:
    """Build the full (timestamp-free, reproducible) error-budget report."""
    per_lane: Dict[str, Dict[str, Any]] = {
        lane: _empty_lane(EXTRACTION_BUDGET) for lane in EXTRACTION_LANES
    }
    per_lane["classification"] = _empty_lane(CLASSIFICATION_BUDGET)
    notices: List[str] = []
    cases_out: Dict[str, Any] = {}

    cases = cr.discover_cases(Path(corpus_root))
    if case_ids is not None:
        wanted = set(case_ids)
        cases = [c for c in cases if c.name in wanted]
        missing = wanted - {c.name for c in cases}
        for m in sorted(missing):
            notices.append("unknown case id skipped: %s" % m)

    for case_dir in cases:
        case_id = case_dir.name
        expected_dir = case_dir / "expected"
        golden_served_path = expected_dir / "served_envelope.json"
        golden_class_path = expected_dir / "classification.json"
        if not golden_served_path.is_file() or not golden_class_path.is_file():
            notices.append(
                "case %s skipped: goldens missing (the corpus gate owns "
                "freezing)" % case_id
            )
            continue
        try:
            lane, served, classification = _run_corpus_case(case_dir)
        except cr.CaseFailure as exc:
            notices.append("case %s skipped: %s" % (case_id, exc))
            continue

        golden_served = json.loads(golden_served_path.read_text(encoding="utf-8"))
        golden_class = json.loads(golden_class_path.read_text(encoding="utf-8"))
        actual_served = cr.normalize(served)
        actual_class = cr.normalize(classification)
        flagged_doc = bool(actual_served.get("needs_review"))

        n_num, mm_num = compare_leaves(
            golden_served, actual_served, numeric_only=True
        )
        _tally(per_lane[lane], n_num, mm_num, flagged_doc, case_id,
               "served_envelope.json")

        n_cls, mm_cls = compare_leaves(
            golden_class, actual_class, numeric_only=False
        )
        _tally(per_lane["classification"], n_cls, mm_cls, flagged_doc, case_id,
               "classification.json")

        cases_out[case_id] = {
            "lane": lane,
            "numeric_fields": n_num,
            "classification_fields": n_cls,
            "flagged_doc": flagged_doc,
        }

    anchors_out: Dict[str, Any] = {
        "labels_path": str(labels_path),
        "available": False,
        "fixtures": {},
    }
    if include_anchors:
        if not Path(labels_path).is_file():
            notices.append(
                "anchor labels absent (%s) — files/ is gitignored, so this "
                "half runs only where the fixtures live; corpus measurement "
                "stays fully strict" % labels_path
            )
        else:
            try:
                labels = json.loads(Path(labels_path).read_text(encoding="utf-8"))
                fixtures = labels.get("fixtures") or {}
                anchors_out["available"] = True
                for name in sorted(fixtures):
                    detail = _compare_fixture_anchors(name, fixtures[name])
                    anchors_out["fixtures"][name] = detail
                    if detail["status"] == "compared":
                        _tally(
                            per_lane["deterministic"],
                            detail["fields_compared"],
                            detail["mismatches"],
                            bool(detail.get("flagged")),
                            "anchor:%s" % name,
                            "verified_anchors_v1.json",
                        )
                    else:
                        notices.append(
                            "anchor fixture %s: %s" % (name, detail["status"])
                        )
            except Exception as exc:  # noqa: BLE001 — labels are external data
                anchors_out["available"] = False
                notices.append(
                    "anchor labels unreadable (%s: %s) — corpus measurement "
                    "stays fully strict" % (type(exc).__name__, exc)
                )
    else:
        notices.append("anchor half skipped (--skip-anchors)")

    for lane in ALL_LANES:
        _finalize_lane(per_lane[lane])

    return {
        "schema": "error_budget_v1",
        "definition": DEFINITION,
        "budgets": {
            "extraction": EXTRACTION_BUDGET,
            "classification": CLASSIFICATION_BUDGET,
        },
        "per_lane": per_lane,
        "anchors": anchors_out,
        "cases": cases_out,
        "notices": notices,
    }


# ── gate + rendering + record ──────────────────────────────────────────


def gate_exit(report: Dict[str, Any]) -> int:
    """E5: 1 iff any SILENT mismatch on the labeled set, or a
    sufficient-N lane above its budget."""
    for lane in ALL_LANES:
        row = report["per_lane"][lane]
        if row["silent_mismatches"] > 0:
            return 1
        if row["sufficient"] and row["rate"] is not None \
                and row["rate"] > row["budget"]:
            return 1
    return 0


def _pct(v: Optional[float]) -> str:
    return "n/a" if v is None else "%.4f%%" % (v * 100.0)


def render(report: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    lines.append("ERROR BUDGET — silent-error-rate gate (labeled sets)")
    lines.append("definition: %s" % report["definition"])
    lines.append(
        "budgets: extraction %s · classification %s (DO NOT WIDEN)"
        % (_pct(report["budgets"]["extraction"]),
           _pct(report["budgets"]["classification"]))
    )
    lines.append("")
    for lane in ALL_LANES:
        row = report["per_lane"][lane]
        if row["n"] == 0:
            lines.append(
                "lane %-17s no measurement source yet — 0 fields; nothing "
                "certified" % lane
            )
            continue
        lines.append(
            "lane %-17s measured %s on %d fields — 95%% CI [%s, %s]"
            % (lane, _pct(row["rate"]), row["n"], _pct(row["ci_low"]),
               _pct(row["ci_high"]))
        )
        if not row["sufficient"]:
            lines.append(
                "     %-17s N INSUFFICIENT to certify <%s (needs ≥%d clean "
                "fields) — measured %s so far, target NOT claimed met"
                % ("", _pct(row["budget"]), row["sufficient_n"],
                   _pct(row["rate"]))
            )
        if row["flagged_mismatches"]:
            lines.append(
                "     %-17s %d FLAGGED mismatch(es) — flagged wrong values "
                "are the system working, not silent errors"
                % ("", row["flagged_mismatches"])
            )
        for mm in row["silent"]:
            lines.append(
                "     SILENT mismatch [%s %s] %s: expected %r, actual %r"
                % (mm.get("case"), mm.get("artifact"), mm.get("path"),
                   mm.get("expected"), mm.get("actual"))
            )
        if row["silent_mismatches"] > len(row["silent"]):
            lines.append(
                "     … %d further silent mismatch(es) not listed"
                % (row["silent_mismatches"] - len(row["silent"]))
            )
    anchors = report.get("anchors") or {}
    if anchors.get("available"):
        compared = sum(
            d.get("fields_compared", 0)
            for d in anchors.get("fixtures", {}).values()
        )
        ncmp = sum(
            len(d.get("not_comparable") or [])
            for d in anchors.get("fixtures", {}).values()
        )
        lines.append("")
        lines.append(
            "anchors: %d labeled fields compared across %d fixture(s); "
            "%d anchor(s) NOT COMPARABLE on the served surface (listed in "
            "the record, never guessed)"
            % (compared, len(anchors.get("fixtures", {})), ncmp)
        )
    for n in report.get("notices") or []:
        lines.append("NOTICE  %s" % n)
    return lines


def record_path() -> Path:
    env = os.environ.get("ENGINE_ERROR_BUDGET_LOG")
    if env:
        return Path(env)
    obs = os.environ.get("ENGINE_OBS_DIR")
    base = Path(obs) if obs else REPO / "data" / "obs"
    return base / "error_budget_last.json"


def write_record(report: Dict[str, Any]) -> Optional[Path]:
    """Battery-record pattern: atomic tmp + os.replace; a write failure
    never masks the measurement."""
    target = record_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(
            json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, target)
        return target
    except OSError as exc:
        print("NOTICE  error-budget record not written (%s)" % exc)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus-root", default=str(cr.DEFAULT_CORPUS))
    parser.add_argument("--case", action="append", default=None,
                        help="measure only this corpus case (repeatable)")
    parser.add_argument("--skip-anchors", action="store_true",
                        help="corpus half only (CI has no files/ fixtures)")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS),
                        help="verified-anchors labels file")
    parser.add_argument("--json", action="store_true",
                        help="print the report JSON instead of the table")
    parser.add_argument("--no-record", action="store_true",
                        help="do not write data/obs/error_budget_last.json")
    args = parser.parse_args(argv)

    try:
        report = measure(
            corpus_root=Path(args.corpus_root),
            case_ids=args.case,
            include_anchors=not args.skip_anchors,
            labels_path=Path(args.labels),
        )
    except Exception as exc:  # noqa: BLE001 — internal error, not a verdict
        import traceback

        traceback.print_exc()
        print("ERROR BUDGET: internal error (%s: %s)" % (type(exc).__name__, exc))
        return 2

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    else:
        for line in render(report):
            print(line)

    if not args.no_record:
        written = write_record(report)
        if written is not None:
            print("record: %s" % written)

    code = gate_exit(report)
    print("ERROR BUDGET: %s" % ("PASS" if code == 0 else
                                "FAIL — silent mismatch or budget exceeded"))
    return code


if __name__ == "__main__":
    sys.exit(main())
