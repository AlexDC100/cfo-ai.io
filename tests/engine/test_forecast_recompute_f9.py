"""forecast-latency (F9, in process; plan/2 B6, plan_contract_v2 11.1).

The chart profile ([series, summary, strip]) POSTed N times through the real
route on every corpus book, at monthly_months 24 with a lever set, so the
removal runs and the inert nudges are inside the measurement.

REDS ON (TC-11): the in-process p50 above packs/forecast/levers.yaml
#latency.chart_inprocess_p50_ms; a chart-profile body above
#latency.body_cap_bytes (per-figure basis prose coming back is what that
catches); N below 20; recompute_ms absent or not an integer. Both thresholds
are read from the pack and printed beside the measurement (TC-10).
CANNOT SEE: the browser (e2e/forecast-cockpit-latency.spec.ts, B9), the
analysis profile (B11), the network.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
import time

from forecast_recompute_harness import BOOKS, _call

N = 20
CHART = {"horizon": {"monthly_months": 24},
         "shocks": [{"id": "rail:volume_index", "driver_key": "volume_index",
                     "op": "level_pct", "value": "-0.20", "ramp_months": 6},
                    {"id": "rail:dso_days", "driver_key": "dso_days", "op": "add_days",
                     "value": "10"}],
         "want": ["series", "summary", "strip"]}


def test_chart_profile_p50_and_body_size_are_inside_the_packed_budget(capsys):
    from engine.forecast.levers_pack import serving_pack
    latency = serving_pack().latency
    rows = []
    for name in BOOKS:
        _call(name, "POST", body=CHART)  # warm: pack loads and the app build
        times, size = [], 0
        for _ in range(N):
            started = time.perf_counter()
            status, body = _call(name, "POST", body=CHART)
            times.append((time.perf_counter() - started) * 1000.0)
            assert status == 200, (name, str(body)[:200])
            assert isinstance(body["recompute_ms"], int)
            assert "figures" not in body
            size = max(size, len(json.dumps(body, separators=(",", ":"), ensure_ascii=False)
                                 .encode("utf-8")))
        times.sort()
        rows.append((name, times[len(times) // 2], times[-1], size))
    with capsys.disabled():
        print("\nSCOPE forecast-latency (plan/2 B6, gate row F9, in process): books %s; "
              "chart profile, monthly_months 24, two shocks; N=%d per book; the clock "
              "includes the loader, the statements rebuild and the TestClient"
              % (", ".join(BOOKS), N))
        for name, p50, worst, size in rows:
            print("  %-10s p50 %.0f ms (budget %d), worst %.0f ms, body %d bytes (cap %d)"
                  % (name, p50, latency["chart_inprocess_p50_ms"], worst, size,
                     latency["body_cap_bytes"]))
        print("GATE-WORK forecast-latency units=%d" % (N * len(rows)))
    assert N >= 20
    for name, p50, _worst, size in rows:
        assert p50 <= latency["chart_inprocess_p50_ms"], (name, p50)
        assert size <= latency["body_cap_bytes"], (name, size)
