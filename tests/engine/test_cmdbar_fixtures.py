"""cmdbar-fixtures — the command bar's "Ce contează acum" fixtures are the
engine's composition, byte for byte, and the bar's own names for a figure
are the engine's names for it.

THE LAW (design C1/C2, "one authority"): the frontend gates that render the
empty state (commandBar.test.tsx: the swap test, the caveat-once test, the
served-figure test) read documents under frontend/lib/__tests__/fixtures/
attention/. If those documents were edited by hand, the bar would be tested
against an authority that does not exist. So:

  1. every committed `*.attention.json` / `*.sector.json` equals a FRESH
     composition (capture_attention.py over the committed served bodies);
  2. the bar's statement-figure names (cmdbarStrings.json `cmdbar.answer.*`)
     equal the attention pack's subjects for the same identity, and the
     filed-basis inventory label equals the pack's `basis_labels` —
     one metric, one name, in both languages;
  3. the bar's synonym table joins only to comparatives lines that exist
     (src/engine/comparatives/lines.py) and to ratio keys the ratio table
     serves — a join to nothing would answer with a refusal forever.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a composer change that moves an
item without the capture being re-run; a hand-edited fixture; a renamed
statement subject on one side only; a synonym entry naming a line or a ratio
the engine does not serve. WHAT IT CANNOT SEE: how the browser prints the
documents (the vitest gates do).
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "attention"
CMDBAR = REPO / "frontend" / "components" / "instrument" / "shell" / "cmdbar"
PACK = REPO / "packs" / "serving" / "attention.yaml"


def _capture():
    spec = importlib.util.spec_from_file_location("capture_attention", FIX / "capture_attention.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_every_fixture_is_a_fresh_engine_composition():
    cap = _capture()
    checked = 0
    for name, world in cap.worlds().items():
        fresh = cap.render(cap.compose(world))
        committed = (FIX / ("%s.attention.json" % name)).read_text(encoding="utf-8")
        assert committed == fresh, (
            "%s.attention.json is not the engine's composition — re-run capture_attention.py" % name)
        checked += 1
        if name not in ("pair", "pair_letter"):
            sector = (FIX / ("%s.sector.json" % name)).read_text(encoding="utf-8")
            assert sector == cap.render(world["sector"]), name
            checked += 1
    # SUBJECT FLOOR: both modes and both swap-test companies were composed.
    assert checked >= 6, checked
    print("GATE-WORK cmdbar-fixtures documents=%d" % checked)


def test_the_swap_test_companies_differ_in_the_engine_already():
    """The frontend swap test renders these two; if the engine served the
    same items for both, the frontend gate would be measuring nothing."""
    a = json.loads((FIX / "scandia.attention.json").read_text(encoding="utf-8"))
    b = json.loads((FIX / "agras.attention.json").read_text(encoding="utf-8"))
    assert a["period"]["company_name"] != b["period"]["company_name"]
    ka = [(i["key"], json.dumps(i["figure"], sort_keys=True)) for i in a["items"]]
    kb = [(i["key"], json.dumps(i["figure"], sort_keys=True)) for i in b["items"]]
    assert len(ka) >= 2 and len(kb) >= 2
    assert ka != kb


def _strings():
    return json.loads((CMDBAR / "cmdbarStrings.json").read_text(encoding="utf-8"))


#: The bar's answer id → the attention pack's statement identity. The net
#: result is the one deliberate difference: the bar prints the account-121
#: provenance as its own tag ("din contul 121") after the name, the pack
#: folds it into the subject — the name before it is held equal below.
ANSWER_IDENTITY = {"turnover": "turnover", "ebitda": "ebitda",
                   "operating_result": "operating_result", "cash": "cash", "debt": "financial_debt"}


def test_one_metric_one_name_between_the_bar_and_the_attention_pack():
    pack = yaml.safe_load(PACK.read_text(encoding="utf-8"))
    by_identity = {l["identity"]: l for l in pack["statement_lines"]}
    strings = _strings()
    for answer_id, identity in ANSWER_IDENTITY.items():
        for lang in ("ro", "en"):
            assert strings[lang]["cmdbar"]["answer"][answer_id] == by_identity[identity]["subject"][lang], (
                answer_id, lang)
    net = by_identity["net_result"]["subject"]
    for lang in ("ro", "en"):
        assert net[lang].startswith(strings[lang]["cmdbar"]["answer"]["net_result"]), lang
    basis = pack["sector"]["basis_labels"]["inventory_days_on_turnover"]
    for lang in ("ro", "en"):
        assert strings[lang]["cmdbar"]["sectorBasis"]["inventory_days_on_turnover"] == basis[lang], lang


def test_the_synonym_table_joins_only_to_served_lines_and_ratios():
    from engine.comparatives.lines import LINE_SPECS

    terms = json.loads((CMDBAR / "cmdbarTerms.json").read_text(encoding="utf-8"))
    lines = {s.key: s for s in LINE_SPECS}
    body = json.loads((REPO / "e2e" / "fixtures" / "workspace_v2" / "scandia_fy2025.json")
                      .read_text(encoding="utf-8"))["period"]
    ratio_keys = {r["key"] for r in body["assembled_metrics"]["ratio_table"]["rows"]}
    sector = json.loads((FIX / "scandia.sector.json").read_text(encoding="utf-8"))
    sector_keys = {r["key"] for r in sector["rows"]}
    for a in terms["answers"]:
        spec = lines.get(a["line"])
        assert spec is not None, a["id"]
        if a["reader"] == "line":
            # The value is read from the SAME served path the column reads.
            assert spec.path == ("assembled_%s" % a["statement"], a["field"]), a["id"]
        for k in ("margin", "ratio"):
            if a.get(k):
                assert a[k] in ratio_keys, (a["id"], a[k])
        if a.get("sector"):
            assert a["sector"] in sector_keys, (a["id"], a["sector"])
        assert a["terms"], a["id"]
    for key in terms["accountMetrics"].values():
        assert key in ratio_keys, key
