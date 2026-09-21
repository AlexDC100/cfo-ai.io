"""forecast-served-sentences (forecast-scenarios-live, RO + EN): the committed
inventory of every sentence the Forecast and Scenarios pages paint IS what the
real route serves.

The pages print the engine's English sentences verbatim in English and re-say
them in Romanian through frontend/lib/forecastSentencesRo.ts — one rule per
engine template, under a digit law. The Romanian rules are held against
tests/engine/fixtures/forecast/served_sentences.json by
frontend/lib/__tests__/forecastSentencesRo.test.ts; THIS test holds that file
against the engine, through create_app over the tenancy double on the four
corpus books (tests/engine/forecast_sentence_inventory.py).

RED ON (TC-11, after the repair): an engine sentence reworded, added or
dropped anywhere the pages paint one (a driver basis, an alternative, a
ladder step, an inert note, a convention, the runway, the funding-rate basis,
a refusal, the unserved list) without the inventory being re-captured — which
is the moment the Romanian rules must be re-read, since a rule that no longer
matches prints the English on a Romanian page. Re-capture:
    PYTHONPATH=src:tests/engine python scripts/gen_fp1_2_fixtures.py

CANNOT SEE: sentences the corpus books never provoke; whether the Romanian
reads well (the frontend gate checks it is Romanian and digit-exact).
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "served_sentences.json"


def test_the_committed_sentence_inventory_is_what_the_route_serves():
    from forecast_sentence_inventory import WORLDS, collect
    served = collect()
    on_disk = json.loads(FIXTURE.read_text(encoding="utf-8"))
    kinds = sorted(set(k for entry in served for k in entry["kinds"]))
    print("SCOPE forecast-served-sentences: worlds %s; %d sentences; kinds %s"
          % (", ".join(w[0] for w in WORLDS), len(served), ", ".join(kinds)))
    print("GATE-WORK forecast-served-sentences units=%d" % len(served))
    assert len(served) > 100, "vacuous: the route served almost no sentences"
    added = [e["text"] for e in served if e not in on_disk]
    dropped = [e["text"] for e in on_disk if e not in served]
    assert not added and not dropped, (
        "served_sentences.json is stale (re-capture with scripts/"
        "gen_fp1_2_fixtures.py, then re-read frontend/lib/forecastSentencesRo.ts)"
        "\n  served, not in the inventory: %s\n  in the inventory, no longer served: %s"
        % (added[:5], dropped[:5]))
    assert on_disk == served
