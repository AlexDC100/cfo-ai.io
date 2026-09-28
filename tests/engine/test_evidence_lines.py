"""evidence-lines — the account view's statement lines ARE the engine's lines.

THE LAW (design C4, "opens the account with provenance", one authority):
the account view (frontend/components/cfo/evidence/EvidenceDrawer.tsx) opens
a statement line — `?line=pl.revenue` — by printing its served figure and
listing the accounts that feed it. It learns both from
frontend/lib/evidence/evidenceLines.json. That file is a MIRROR of the
engine's comparatives line registry (src/engine/comparatives/lines.py), so:

  1. every entry is a registry line, and its `(statement, field)` is the
     SERVED path the registry reads (`assembled_<statement>.<field>`) — the
     figure the view prints is the column's own `current`;
  2. its `buckets` are the registry's `source_buckets` for the line (the
     registry's coverage mechanism: the buckets whose leaves feed it) — or,
     for a derived line declared `from_lines`, the union of those lines'
     buckets, and the committed served bodies show the engine's figure IS
     that sum, to the cent (bs.total_debt = short-term + long-term debt);
  2b. THE FEEDS ARE THE FIGURE (critic round 2, 2026-09-28): the leaves a
     line lists as feeding it — its buckets' served line items, under the
     registry's `source_accounts` where the field is narrower than its
     buckets — sum to its served figure within the zero floor, on every
     committed served body that carries line items; and no line lists an
     account-711 leaf (the gross production stocked on a closed book is not
     "Other operating income": the stock variation is its own measured line,
     design A1 / A6). The measured defect: "Other operating income" printed
     the 758 figure over ten 711 leaves and the 781 reversals, under
     "Sold" / "Balance";
  3. a line with `accounts` is the attention pack's `requires_anchor` line
     (the net result IS account 121) and nothing else;
  4. COVERAGE: every line an evidence link can name has an entry — the
     attention pack's statement lines, the findings' statement evidence, the
     command bar's statement answers — or its link would open a view that
     says "unknown line";
  5. ONE METRIC, ONE NAME: the entry's name is the attention pack's subject
     where the pack names the line, else the command bar's answer name,
     else the registry label (EN), in both languages.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a mirror path, bucket list or
account-prefix list that drifts from the registry (the view would list the
wrong accounts under a line, or print another figure); a derived line whose
declared constituents do not sum to the served figure; a line whose listed
feeds do not sum to its served figure, or that lists a 711 leaf; a new pack line / finding line / answer
with no entry; a renamed subject on one side only. WHAT IT CANNOT SEE: how
the browser renders the view (evidenceLanding.test.tsx, gate cmdbar-evidence).
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
MIRROR = REPO / "frontend" / "lib" / "evidence" / "evidenceLines.json"
PACK = REPO / "packs" / "serving" / "attention.yaml"
CMDBAR = REPO / "frontend" / "components" / "instrument" / "shell" / "cmdbar"
BODIES = [
    REPO / "e2e" / "fixtures" / "workspace_v2" / "scandia_fy2025.json",
    REPO / "e2e" / "fixtures" / "workspace_v2" / "agras_fy2025.json",
]
PAIR = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "comparatives" / "pair_served.json"



def _mirror():
    return json.loads(MIRROR.read_text(encoding="utf-8"))["lines"]


def _pack():
    return yaml.safe_load(PACK.read_text(encoding="utf-8"))


def _terms():
    return json.loads((CMDBAR / "cmdbarTerms.json").read_text(encoding="utf-8"))


def _cmdbar_strings():
    return json.loads((CMDBAR / "cmdbarStrings.json").read_text(encoding="utf-8"))


def _registry():
    from engine.comparatives.lines import LINE_SPECS

    return {s.key: s for s in LINE_SPECS}


def test_every_entry_reads_the_registry_path_and_its_buckets():
    reg = _registry()
    mirror = _mirror()
    checked = 0
    for key, e in mirror.items():
        spec = reg.get(key)
        assert spec is not None, "%s is not a comparatives line" % key
        assert spec.path == ("assembled_%s" % e["statement"], e["field"]), (key, spec.path)
        assert e["reader"] in ("line", "ebitda", "net_result"), key
        if e.get("from_lines"):
            union = []
            for part in e["from_lines"]:
                pspec = reg.get(part)
                assert pspec is not None, (key, part)
                for b in pspec.source_buckets:
                    if b not in union:
                        union.append(b)
            assert spec.source_buckets == (), "%s declares from_lines but the registry feeds it directly" % key
            assert e["buckets"] == union, (key, e["buckets"], union)
        else:
            assert e["buckets"] == list(spec.source_buckets), (key, e["buckets"], spec.source_buckets)
        assert e.get("source_accounts", []) == list(spec.source_accounts), (
            key, e.get("source_accounts"), spec.source_accounts)
        checked += 1
    assert checked >= 10, checked
    print("GATE-WORK evidence-lines lines=%d" % checked)


def test_a_derived_line_is_the_served_sum_of_its_declared_lines():
    reg = _registry()
    mirror = _mirror()
    bodies = [json.loads(p.read_text(encoding="utf-8"))["period"] for p in BODIES]
    bodies.append(json.loads(PAIR.read_text(encoding="utf-8"))["current_body"])
    sums = 0
    for key, e in mirror.items():
        if not e.get("from_lines"):
            continue
        for body in bodies:
            st = body["statements"]
            path = reg[key].path
            whole = st[path[0]][path[1]]
            parts = [st[reg[p].path[0]][reg[p].path[1]] for p in e["from_lines"]]
            assert abs(whole - sum(parts)) < 0.005, (key, whole, parts)
            sums += 1
    assert sums >= 3, sums


def _feeds(items, buckets, prefixes):
    """The leaves the account view lists as feeding a line: its buckets'
    served line items (the persisted names the period serves), under its
    account prefixes when it declares any — evidenceView.buildEvidenceModel's
    rule, restated here from the registry, not imported from the browser."""
    out = []
    for li in items:
        if li.get("statement") == "IGNORED":
            continue
        code = str(li.get("ro_account_code") or "")
        if li.get("bucket") not in buckets:
            continue
        if prefixes and not code.startswith(tuple(prefixes)):
            continue
        out.append(li)
    return out


def test_a_lines_listed_feeds_sum_to_its_served_figure_and_are_never_711():
    reg = _registry()
    mirror = _mirror()
    bodies = {p.stem: json.loads(p.read_text(encoding="utf-8"))["period"] for p in BODIES}
    judged = 0
    narrowed = 0
    for name, body in bodies.items():
        items = body.get("line_items") or []
        # VACUITY: a body with no line items lists no feeds at all.
        assert len(items) > 50, (name, len(items))
        st = body["statements"]
        for key, e in mirror.items():
            spec = reg[key]
            # Every line whose view LISTS feeds — a derived line declared
            # `from_lines` lists its constituents' leaves (bs.total_debt).
            if not e["buckets"]:
                continue
            served = st[spec.path[0]].get(spec.path[1])
            assert isinstance(served, (int, float)), (name, key, served)
            everything = _feeds(items, e["buckets"], ())
            listed = _feeds(items, e["buckets"], e.get("source_accounts", []))
            assert listed, "%s/%s: the line lists no feed beside a served %s" % (name, key, served)
            total = sum(float(li.get("amount") or 0) for li in listed)
            assert abs(total - served) < 0.005, (
                "%s/%s: the listed feeds sum to %.2f, the served figure is %.2f"
                % (name, key, total, served))
            bad = sorted(str(li["ro_account_code"]) for li in listed
                         if str(li["ro_account_code"]).startswith("711"))
            assert not bad, "%s/%s lists account-711 leaves as feeding it: %s" % (name, key, bad)
            if len(everything) != len(listed):
                # POSITIVE CONTROL: the bucket alone would list more — here,
                # the 711 memo and the 781 reversals — and would not foot.
                narrowed += 1
                wide = sum(float(li.get("amount") or 0) for li in everything)
                assert abs(wide - served) >= 0.005, (name, key)
                assert any(str(li["ro_account_code"]).startswith("711") for li in everything), (name, key)
            judged += 1
    assert narrowed >= 2, narrowed
    assert judged >= 16, judged
    print("GATE-WORK evidence-lines feeds=%d narrowed=%d" % (judged, narrowed))


def test_only_the_anchored_net_result_is_an_account():
    pack = _pack()
    anchored = {l["key"] for l in pack["statement_lines"] if l.get("requires_anchor")}
    with_accounts = {k for k, e in _mirror().items() if e.get("accounts")}
    assert with_accounts == anchored == {"pl.net_income"}
    assert _mirror()["pl.net_income"]["accounts"] == ["121"]
    assert _mirror()["pl.net_income"]["reader"] == "net_result"
    assert _mirror()["pl.ebitda"]["reader"] == "ebitda"


def test_every_line_an_evidence_link_can_name_is_declared():
    pack = _pack()
    mirror = _mirror()
    named = set()
    named |= {l["key"] for l in pack["statement_lines"]}
    named |= {d["evidence"]["line"] for d in pack["insights"]["detectors"].values()
              if d["evidence"]["kind"] == "statement"}
    named |= {a["line"] for a in _terms()["answers"]}
    missing = sorted(named - set(mirror))
    assert not missing, "no evidence entry for %s" % missing
    assert len(named) >= 10


def test_one_metric_one_name():
    pack = _pack()
    mirror = _mirror()
    reg = _registry()
    by_pack = {l["key"]: l["subject"] for l in pack["statement_lines"]}
    strings = _cmdbar_strings()
    by_answer = {a["line"]: a["id"] for a in _terms()["answers"]}
    for key, e in mirror.items():
        for lang in ("ro", "en"):
            if key in by_pack:
                want = by_pack[key][lang]
            elif key in by_answer:
                want = strings[lang]["cmdbar"]["answer"][by_answer[key]]
            elif lang == "en":
                want = reg[key].label
            else:
                assert e["name"]["ro"].strip(), key
                continue
            assert e["name"][lang] == want, (key, lang, e["name"][lang], want)
