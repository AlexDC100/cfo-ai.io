"""forecast-byte-stability (F8, plan/2 B6, plan_contract_v2 3.12): one request
gives one body, in this process and in another.

REDS ON (TC-11): two POSTs of one request differing in body_hash; the served
body_hash not being the sha256 of the body minus body_hash and recompute_ms;
recompute_ms inside the hash; a SECOND PROCESS (fresh interpreter, its own
hash seed) serving a different body_hash for the same request on any corpus
book; lever_set_hash depending on the order levers were sent or on a decimal's
spelling ("0.10" vs "0.1"); zero cells compared (TC-3).
CANNOT SEE: saved-case replay (B15), the export (B20), compares (B11).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from forecast_recompute_harness import BASE3, BOOKS, levered_for, post

REPO = Path(__file__).resolve().parents[2]
CHILD = """
import json, sys
sys.path.insert(0, %r)
from forecast_recompute_harness import BASE3, BOOKS, levered_for, post
out = {}
for name in BOOKS:
    out[name] = [post(name, BASE3)["body_hash"], post(name, levered_for(name)[0])["body_hash"]]
print("HASHES " + json.dumps(out, sort_keys=True))
"""


def test_one_request_one_body_across_calls_and_across_processes(capsys):
    from engine.forecast_serving import plan_response
    here = {}
    for name in BOOKS:
        levered, _ids = levered_for(name)
        a, b = post(name, BASE3), post(name, BASE3)
        assert a["body_hash"] == b["body_hash"], name
        assert a["body_hash"] == plan_response.body_hash(a), name
        moved = dict(a, recompute_ms=a["recompute_ms"] + 999)
        assert plan_response.body_hash(moved) == a["body_hash"], "recompute_ms is inside the hash"
        here[name] = [a["body_hash"], post(name, levered)["body_hash"]]
    env = dict(os.environ, PYTHONHASHSEED="12345",
               PYTHONPATH=os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")]))
    done = subprocess.run([sys.executable, "-c", CHILD % str(REPO / "tests" / "engine")],
                          env=env, cwd=str(REPO), capture_output=True, text=True, timeout=80)
    line = [l for l in done.stdout.splitlines() if l.startswith("HASHES ")]
    assert line, "the second process served nothing: %s" % done.stderr[-400:]
    there = json.loads(line[0][len("HASHES "):])
    assert there == here, "another process serves different bytes: %s" % sorted(
        n for n in here if here[n] != there.get(n))
    with capsys.disabled():
        print("\nSCOPE forecast-byte-stability (plan/2 B6, gate row F8): books %s; base and "
              "levered 3y/12m; two calls in process, one fresh interpreter with "
              "PYTHONHASHSEED=12345" % ", ".join(BOOKS))
        print("GATE-WORK forecast-byte-stability units=%d" % (len(here) * 4))


def test_lever_set_hash_ignores_order_and_decimal_spelling():
    body, _ids = levered_for("agras")
    a = post("agras", body)
    flipped = json.loads(json.dumps(body))
    flipped["shocks"] = list(reversed(flipped["shocks"]))
    flipped["shocks"][-1]["value"] = "-0.2"
    flipped["behaviour_overrides"][0]["fixed_share"] = "0.50"
    b = post("agras", flipped)
    assert a["lever_set_hash"] == b["lever_set_hash"]
    assert a["body_hash"] == b["body_hash"]
    assert post("agras", BASE3)["lever_set_hash"] != a["lever_set_hash"]
