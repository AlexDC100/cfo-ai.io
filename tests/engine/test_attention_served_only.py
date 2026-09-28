"""attention-served-only — "Ce contează acum" prints served figures and
nothing else: no model sentence, no model numeral, no persisted number the
served surfaces do not print.

THE LAW (owner spec 2026-09-26: "every number from the engine's served facts,
never the model"; design C1: "`recommendations[]` and any narrate output are
excluded"). Four checks, over every served world the repo holds (the
comparatives pair capture, and the five corpus books read back through the
real router, each with its sector document):

  1. SOURCE EQUALITY — every item carries the served object it was read from
     (a comparatives column, a sector row, a ratio compare row, an insight
     measure) and names its path; the object at that path in the served
     document is byte-for-byte the object on the item. Nothing is re-derived.
  2. SENTINEL — model text (a unique phrase and numeral) is planted in every
     field the document must not read: `recommendations[]`, `briefing`,
     `alerts[]`, `metrics[]`, the persisted credit rows, each insight's
     `narrative` / `claim` / `title`, the band findings' prose, the
     comparatives' prior metric rows. The document composed over the planted
     bodies must be IDENTICAL to the one composed over the clean bodies, and
     the sentinel must appear nowhere in it.
  3. IMPORTS — `engine.attention` imports no model, narration, briefing or
     recommendation module (an allowlist, not a denylist).
  4. THE ROUTE'S CALL — GET /attention hands the composer exactly the served
     documents (period body, prior, comparatives, sector, features) and no
     other source.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11): an item figure that is not the
served object at its declared path; any byte of a planted model field in the
document, or a document that changes when only such a field changes; an
import outside the allowlist; a new argument on the route's composer call.
WHAT IT CANNOT SEE: whether the ranking is right (test_attention_rules.py);
the route's wall (test_attention_route_real_app.py); the browser's printing
(the frontend gates).
"""
from __future__ import annotations

import ast
import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.attention import EXCLUDED_SOURCES, compose_attention

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "frontend" / "lib" / "__tests__" / "fixtures"
PKG = REPO / "src" / "engine" / "attention"
PIPELINE = REPO / "src" / "engine" / "api" / "pipeline.py"

SENTINEL = "MODEL-SENTINEL 987654.32 zile lente"
SENTINEL_NUMBER = 987654.32

PRIOR_FOUND = {"rule": "same_company_previous_period_same_length", "requested": "auto",
               "status": "found", "period_id": "period-prior", "period_start": "2024-01-01",
               "period_end": "2024-12-31", "reason": None,
               "available_period_id": None, "available_period_end": None}
PRIOR_ABSENT = dict(PRIOR_FOUND, status="absent", period_id=None, period_start=None,
                    period_end=None, reason={"code": "no_same_length_prior", "inputs": []})


# ── the served worlds ────────────────────────────────────────────────────


def _pair_world() -> Dict[str, Any]:
    doc = json.loads((FIX / "comparatives" / "pair_served.json").read_text(encoding="utf-8"))
    sector = json.loads((FIX / "sectorBenchmark" / "served_pair.json").read_text(encoding="utf-8"))
    return {"name": "pair_served", "period": doc["current_body"],
            "comparatives": doc["comparatives"], "sector": sector["with_prior"],
            "prior": PRIOR_FOUND}


def _letter_world() -> Dict[str, Any]:
    """The pair with the composite letter first among the band crossings and
    every statutory line quiet, so a ratio-band item (the letter, with its
    reason) is on the document too."""
    w = _pair_world()
    cmp = copy.deepcopy(w["comparatives"])
    for col in cmp["columns"]:
        if col["key"] in ("pl.revenue", "pl.ebitda", "pl.ebit", "pl.net_income",
                          "bs.cash", "bs.total_debt") and col["current"] is not None:
            col.update(prior=col["current"] - 1.0, delta=1.0, delta_pct=None,
                       status="compared", change_kind="compared")
    bm = cmp["ratios"]["band_movements"]
    bm["improved"] = ["letter_grade"] + [k for k in bm["improved"] if k != "letter_grade"]
    return dict(w, name="pair_letter", comparatives=cmp)


@pytest.fixture(scope="module")
def worlds() -> List[Dict[str, Any]]:
    import _served_books as SB
    from engine.benchmarks_ro.sector import build_sector_benchmark

    out = [_pair_world(), _letter_world()]
    for name in SB.ALL_BOOKS:
        body = SB.served_body(name)
        out.append({"name": name, "period": body, "comparatives": None,
                    "sector": build_sector_benchmark(body, caen="1011"), "prior": PRIOR_ABSENT})
    return out


def _compose(w: Dict[str, Any]) -> Dict[str, Any]:
    return compose_attention(w["period"], prior=w["prior"], comparatives=w["comparatives"],
                             sector=w["sector"], features={"forecast": "active"})


# ── 1. source equality ───────────────────────────────────────────────────

_STEP = re.compile(r"^(?P<field>[A-Za-z_]+)(?:\[(?P<k>[a-z_]+)=(?P<v>[^\]]+)\])?$")


def _resolve(doc: Any, path: str) -> Any:
    """`columns[key=pl.revenue]`, `ratios.rows[key=roa]`,
    `statements.insights.insights[id=asset_age].measures[key=depreciated_share]`."""
    node = doc
    for part in re.findall(r"[A-Za-z_]+(?:\[[^\]]+\])?", path):
        m = _STEP.match(part)
        assert m, part
        node = node[m.group("field")]
        if m.group("k"):
            hits = [x for x in node if isinstance(x, dict) and str(x.get(m.group("k"))) == m.group("v")]
            assert len(hits) == 1, (path, part, len(hits))
            node = hits[0]
    return node


def _source_doc(w: Dict[str, Any], name: str) -> Any:
    return {"comparatives": w["comparatives"], "sector_benchmark": w["sector"],
            "period": w["period"]}[name]


_FIGURE_OF = {"comparatives_column": "column", "sector_row": "row",
              "ratio_compare_row": "row", "insight_measure": "measure"}


def test_every_item_figure_is_the_served_object_at_its_declared_path(worlds):
    checked = 0
    families = set()
    for w in worlds:
        doc = _compose(w)
        for item in doc["items"]:
            src = _source_doc(w, item["source"]["document"])
            served = _resolve(src, item["source"]["path"])
            fig = item["figure"][_FIGURE_OF[item["figure"]["kind"]]]
            assert json.dumps(fig, sort_keys=True) == json.dumps(served, sort_keys=True), (
                w["name"], item["key"], item["source"])
            if "because" in item:
                again = _resolve(src, item["because"]["source"]["path"])
                assert item["because"]["composite_row"] == again, (w["name"], item["key"])
                assert item["because"]["finding_id"] == served["finding_id"]
                assert item["because"]["rung_crossed"] == served["movement"]["rung_crossed"]
            checked += 1
            families.add(item["family"])
    # SUBJECT FLOOR (TC-9): the census must have looked at every family.
    assert families == {"statement_line", "sector_row", "ratio_band", "insight"}, families
    assert checked >= 15, checked
    print("GATE-WORK attention-served-only items=%d" % checked)


# ── 2. the sentinel ──────────────────────────────────────────────────────


def _plant_period(body: Dict[str, Any]) -> Dict[str, Any]:
    body = copy.deepcopy(body)
    body["recommendations"] = [{"id": "rec-1", "title": SENTINEL, "body": SENTINEL,
                                "impact_ron": SENTINEL_NUMBER, "urgency": "high"}]
    body["briefing"] = {"text": SENTINEL, "headline": SENTINEL, "figures": [SENTINEL_NUMBER]}
    body["alerts"] = [{"rule_key": "ai_council", "title": SENTINEL, "body": SENTINEL,
                       "severity": "critical", "facts_cited": [SENTINEL_NUMBER]}]
    for m in body.get("metrics") or []:
        m["value"] = SENTINEL_NUMBER
    for m in body.get("credit_metrics_as_filed") or []:
        if isinstance(m, dict):
            m["value"] = SENTINEL_NUMBER
    ins = (body.get("statements") or {}).get("insights") or {}
    for i in ins.get("insights") or []:
        i["narrative"] = {"text": SENTINEL, "source": "model", "figure": SENTINEL_NUMBER}
        i["claim"] = SENTINEL
        i["claim_template"] = SENTINEL
        i["title"] = SENTINEL
    return body


def _plant_comparatives(cmp: Any) -> Any:
    if cmp is None:
        return None
    cmp = copy.deepcopy(cmp)
    cmp["prior_metrics"] = [{"name": "net_income", "value": SENTINEL_NUMBER}]
    for f in cmp["ratios"]["band_movements"].get("findings") or []:
        for k in ("body", "body_template", "title", "title_template", "so_what"):
            if k in f:
                f[k] = SENTINEL
    for m in cmp["movers"].get("top") or []:
        m["label"] = SENTINEL
    return cmp


def test_no_model_field_reaches_the_document_or_changes_it(worlds):
    planted_fields = 0
    for w in worlds:
        clean = json.dumps(_compose(w), sort_keys=True, ensure_ascii=False)
        dirty_world = dict(w, period=_plant_period(w["period"]),
                           comparatives=_plant_comparatives(w["comparatives"]))
        dirty = json.dumps(_compose(dirty_world), sort_keys=True, ensure_ascii=False)
        assert "MODEL-SENTINEL" not in dirty, w["name"]
        assert "987654" not in dirty, w["name"]
        assert dirty == clean, (w["name"], "a field the document must not read changed it")
        planted_fields += 1
    assert planted_fields >= 7, planted_fields
    print("SCOPE attention-served-only sentinel worlds=%d" % planted_fields)
    for name in ("recommendations", "briefing", "alerts"):
        assert name in EXCLUDED_SOURCES


# ── 3. imports ───────────────────────────────────────────────────────────

#: What engine.attention may import. Nothing that can call, hold or narrate a
#: model; nothing that serves recommendations; nothing from the API layer.
ALLOWED_IMPORTS = {
    "__future__", "copy", "calendar", "os", "functools", "typing", "yaml",
    "engine.comparatives.analysis", "engine.comparatives.columns",
    "engine.comparatives.lines",
    # THE inventory-days block's reader (`served_block`, pure) — the one
    # authority for the figure (merge contract 2026-09-28): no model, no
    # narration, no I/O at import.
    "engine.ratios.inventory_days",
}


def test_the_package_imports_no_model_or_narration_module():
    seen = set()
    files = sorted(PKG.glob("*.py"))
    assert len(files) >= 4, files
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:  # relative: inside the package
                    continue
                names = [node.module or ""]
            else:
                continue
            for name in names:
                seen.add(name)
                assert name in ALLOWED_IMPORTS, (path.name, name)
    assert "engine.comparatives.analysis" in seen and "yaml" in seen


# ── 4. the route's call ──────────────────────────────────────────────────


def test_the_route_hands_the_composer_only_the_served_documents():
    tree = ast.parse(PIPELINE.read_text(encoding="utf-8"))
    route = next(n for n in ast.walk(tree)
                 if isinstance(n, ast.FunctionDef) and n.name == "get_period_attention")
    calls = [n for n in ast.walk(route) if isinstance(n, ast.Call)
             and getattr(n.func, "id", None) == "compose_attention"]
    assert len(calls) == 1, len(calls)
    call = calls[0]
    assert len(call.args) == 1 and ast.unparse(call.args[0]) == "payload_of(period_id)"
    assert sorted(k.arg for k in call.keywords) == [
        "comparatives", "comparatives_reason", "features", "prior", "sector"]
    body = route.body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
        body = body[1:]  # the docstring names what is excluded; the code must not read it
    code = "\n".join(ast.unparse(n) for n in body)
    for forbidden in ("recommendation", "briefing", "narrat", "alerts", "chat", "anthropic",
                      "advisory", "model_registry", "capsule"):
        assert forbidden not in code.lower(), forbidden
    assert "surface='attention'" in code or 'surface="attention"' in code
