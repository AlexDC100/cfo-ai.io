"""The committed WRITER of `stage_compute_rows_pre_extraction.json`.

The golden pins `compute_period_metrics` byte for byte; it moves only in a
deliberate, named commit. This script is that commit's tool: it recomputes
every case from the case's own input (`test_credit_model_pure._case_input`),
PRINTS THE BLAST RADIUS (every row whose value moved, per case), and writes
only with `--write`. `--expect-only NAME[,NAME]` refuses to write when any
other row moved. `--reason TEXT` is appended to `_meta.recaptured`.

First used 2026-09-19 (decisions D14: interest_coverage -> EBIT / interest),
when it lived in a scratchpad and the fixture had no committed writer.

  .venv/bin/python tests/engine/fixtures/credit_model/recapture_stage_compute_golden.py \\
      --expect-only interest_coverage            # dry run: prints what would move
  ... --write --reason "2026-..-.. after <what moved and why>"
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))


def _opt(flag):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else None


GOLDEN = REPO / "tests/engine/fixtures/credit_model/stage_compute_rows_pre_extraction.json"
raw = GOLDEN.read_text("utf-8")
golden = json.loads(raw)


def dump(obj):
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + ("\n" if raw.endswith("\n") else "")


assert dump(golden) == raw, "formatting does not round-trip; refuse to write"

import test_credit_model_pure as T  # noqa: E402  (its _case_input)
from engine.ratios import credit_model as CM  # noqa: E402

moved = {}
for name, case in sorted(golden["cases"].items()):
    statements, sq = T._case_input(case)
    rows = CM.compute_period_metrics(statements, source_data_quality=sq)
    assert rows[-1]["name"] == "credit_model_revision"
    rows = rows[:-1]
    old = {r["name"]: r for r in case["rows"]}
    new_rows = []
    for r in rows:
        row = {k: r[k] for k in ("name", "value", "unit", "direction")}
        row["org_id"] = "org-gate"
        row["period_id"] = "period-gate"
        new_rows.append(row)
        o = old.get(r["name"])
        if o is None or any(o[k] != row[k] for k in ("value", "unit", "direction")):
            moved.setdefault(name, []).append({
                "name": r["name"],
                "before": None if o is None else o["value"],
                "after": row["value"],
            })
    gone = [n for n in old if n not in {r["name"] for r in rows}]
    assert not gone, (name, gone)
    case["rows"] = new_rows

for name, rows in moved.items():
    for m in rows:
        print("%-40s %-28s %r -> %r" % (name, m["name"], m["before"], m["after"]))

expect_only = _opt("--expect-only")
if expect_only is not None:
    allowed = set(expect_only.split(","))
    stray = {n: [m for m in rows if m["name"] not in allowed] for n, rows in moved.items()}
    stray = {n: r for n, r in stray.items() if r}
    assert not stray, "rows outside --expect-only moved: %r" % stray
if not moved:
    print("nothing moved: the golden is what the model computes today")

reason = _opt("--reason")
if "--write" in sys.argv:
    assert moved, "nothing moved; refuse to rewrite"
    assert reason, "--write needs --reason (what moved and why)"
    meta = golden["_meta"]
    meta["recaptured"] = meta["recaptured"] + "; " + reason
    meta.setdefault("rows_moved_on_recapture", []).append({"reason": reason, "moved": {
        name: [{"name": m["name"], "before": m["before"], "after": m["after"]} for m in rows]
        for name, rows in sorted(moved.items())}})
    GOLDEN.write_text(dump(golden), "utf-8")
    print("written")
