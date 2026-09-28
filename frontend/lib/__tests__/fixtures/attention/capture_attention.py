"""The command bar's "Ce contează acum" fixtures, COMPOSED BY THE ENGINE.

Nothing here is hand-written: every document is `engine.attention.
compose_attention` over served bodies the repo already commits —

  pair          the comparatives pair capture (frontend/lib/__tests__/fixtures/
                comparatives/pair_served.json, Dec 2025 vs Dec 2024) with its
                sector document (sectorBenchmark/served_pair.json with_prior):
                the with-prior mode (movement, worst vs sector, improvement).
  scandia/agras the two period bodies the hermetic e2e double serves
                (e2e/fixtures/workspace_v2/{scandia,agras}_fy2025.json, G7
                captures of the anonymized corpus books) with the sector
                document `build_sector_benchmark` makes of each: the single-
                period mode, and the SWAP TEST's two companies.

Held equal to a fresh composition by tests/engine/test_cmdbar_fixtures.py
(gate `cmdbar-fixtures`): a composer change that moves an item reds there,
and the capture is re-run, never edited.

    PYTHONPATH=src python frontend/lib/__tests__/fixtures/attention/capture_attention.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
sys.path.insert(0, str(REPO / "src"))

from engine.attention import compose_attention  # noqa: E402
from engine.benchmarks_ro.sector import build_sector_benchmark  # noqa: E402

FIX = REPO / "frontend" / "lib" / "__tests__" / "fixtures"
E2E = REPO / "e2e" / "fixtures" / "workspace_v2"

#: The sector the corpus books are benchmarked against (the attention gates'
#: own choice for every corpus book, tests/engine/test_attention_served_only).
CORPUS_CAEN = "1011"

PRIOR_FOUND = {"rule": "same_company_previous_period_same_length", "requested": "auto",
               "status": "found", "period_id": "period-prior", "period_start": "2024-01-01",
               "period_end": "2024-12-31", "reason": None,
               "available_period_id": None, "available_period_end": None}
PRIOR_ABSENT = dict(PRIOR_FOUND, status="absent", period_id=None, period_start=None,
                    period_end=None, reason={"code": "no_same_length_prior", "inputs": []})


def worlds() -> Dict[str, Dict[str, Any]]:
    pair = json.loads((FIX / "comparatives" / "pair_served.json").read_text(encoding="utf-8"))
    sector_pair = json.loads((FIX / "sectorBenchmark" / "served_pair.json").read_text(encoding="utf-8"))
    out = {"pair": {"period": pair["current_body"], "comparatives": pair["comparatives"],
                    "sector": sector_pair["with_prior"], "prior": PRIOR_FOUND}}
    # The pair with the composite letter first among the band crossings and
    # every statutory line quiet — the engine gate's own `_letter_world`
    # (tests/engine/test_attention_served_only.py): a ratio-band item, and
    # with it the "restated comparatives" caveat the panel prints ONCE.
    cmp = json.loads(json.dumps(pair["comparatives"]))
    for col in cmp["columns"]:
        if col["key"] in ("pl.revenue", "pl.ebitda", "pl.ebit", "pl.net_income",
                          "bs.cash", "bs.total_debt") and col["current"] is not None:
            col.update(prior=col["current"] - 1.0, delta=1.0, delta_pct=None,
                       status="compared", change_kind="compared")
    bm = cmp["ratios"]["band_movements"]
    bm["improved"] = ["letter_grade"] + [k for k in bm["improved"] if k != "letter_grade"]
    out["pair_letter"] = dict(out["pair"], comparatives=cmp)
    for name in ("scandia", "agras"):
        body = json.loads((E2E / ("%s_fy2025.json" % name)).read_text(encoding="utf-8"))["period"]
        out[name] = {"period": body, "comparatives": None,
                     "sector": build_sector_benchmark(body, caen=CORPUS_CAEN), "prior": PRIOR_ABSENT}
    return out


def compose(world: Dict[str, Any]) -> Dict[str, Any]:
    # No feature status is read (ruling R4): the bank report is the CFO
    # Report PDF whether or not the Forecast feature is on.
    return compose_attention(world["period"], prior=world["prior"], comparatives=world["comparatives"],
                             sector=world["sector"])


def render(doc: Any) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def main() -> None:
    for name, world in worlds().items():
        (HERE / ("%s.attention.json" % name)).write_text(render(compose(world)), encoding="utf-8")
        if name not in ("pair", "pair_letter"):
            (HERE / ("%s.sector.json" % name)).write_text(render(world["sector"]), encoding="utf-8")
        print("wrote", name)


if __name__ == "__main__":
    main()
