"""Regenerate tests/engine/fixtures/forecast/fp1_agras_engine_one_period.json:
the served ProjectionGateway form of project_payload(agras, horizon_years=3)
scoped to FY2028, json indent 1 sort_keys. --no-rows reproduces the e924e4e
bytes (that generator dropped line_items); --write writes the fixture."""
import json, sys
from pathlib import Path
from engine.forecast import project_payload
from engine.forecast_serving.adapter import fp1_from_forecast_v1
from engine.forecast_serving.gateway import ProjectionGateway
REPO = Path.cwd(); OUT = REPO / "tests/engine/fixtures/forecast/fp1_agras_engine_one_period.json"
book = json.loads((REPO / "tests/engine/fixtures/firm/saga_10_col_agras.json").read_text(encoding="utf-8"))
payload = {"envelope": book["envelope"], "statements": book["statements"],
           "period_end": book["period_end"], "currency": book.get("currency") or "RON"}
if "--no-rows" not in sys.argv:
    payload["line_items"] = book["line_items"]
full = fp1_from_forecast_v1(project_payload(payload, horizon_years=3).as_dict())
P = "FY2028"
full["horizon"] = [P]
full["figures"] = [f for f in full["figures"] if f["period"] == P]
for a in full["assumptions"]:
    a["values"] = {k: v for k, v in a["values"].items() if k == P}
body = ProjectionGateway(full).as_dict()
body["balance_check"] = [b for b in body["balance_check"] if b["period"] == P]
text = json.dumps(body, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
same = OUT.read_text(encoding="utf-8") == text
print("byte-identical to committed:", same, "; pool ids:",
      [a["id"] for a in body["assumptions"] if a["id"].startswith("pool_fixed_share.")])
if "--write" in sys.argv:
    OUT.write_text(text, encoding="utf-8")
