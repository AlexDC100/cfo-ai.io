"""The 'annotate' takedown action must actually change the served page.

Cross-lane gap, closed 2026-08-29. takedown.py owns the state machine and
exposes ``annotation(cui)`` plus the honest probe
``page_layer_renders_annotations()``; the page layer owns the rendering.
The remediation lanes ran with disjoint file ownership, so the takedown
lane could design the contract but could not wire it — it reported the
exact integration instead, and this suite is that integration's proof.

Why it matters: an operator resolving a company's dispute with the
SOFTER action (annotate rather than remove) got 200 {ok:true,
state:"annotate"} back and a byte-identical page still presenting the
disputed figures. They would close the complaint believing the page had
changed. The endpoint now reports "not-rendered" when no renderer is
wired, and this suite makes the wired case real.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public_ro import takedown
from engine.public_ro.pages import router as router_mod
from engine.public_ro.pages import templates
from engine.public_ro.store import PublicRoStore

CUI = 880001
NAME = "Disputa Figuri SRL"
SLUG = "disputa-figuri-srl"
CANON = {"host": "cfo-ai.io"}


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(db))
    monkeypatch.setenv("PUBLIC_RO_TAKEDOWN_DB", str(db))
    monkeypatch.setenv("PUBLIC_RO_PAGES_DIR", str(tmp_path / "pages"))
    monkeypatch.setenv("PUBLIC_RO_SITEMAP_DIR", str(tmp_path / "sitemaps"))
    router_mod.reset_default_store()

    st = PublicRoStore(db)
    st.register_dataset(
        dataset_id="uu-2024", year=2024, family="UU", sha256="c" * 64,
        source_url="https://data.gov.ro/dataset/situatii_financiare_2024",
        resource_id="r1", license_id="CC-BY-4.0", license_note=None,
        row_count=1, fetched_at="2026-06-15T00:00:00Z")
    st.ensure_company_stub(CUI, "1071")
    st.set_identification(CUI, name=NAME, county="Cluj", locality="Cluj",
                          reg_number="J12/7/2012", tip_contrib="PJ",
                          publishable=True, name_source="identification")
    for i, year in enumerate((2023, 2024)):
        st.upsert_filing(cui=CUI, year=year, family="UU",
                         dataset_id="uu-2024", caen="1071",
                         total_assets=9_000_000 + i, net_result=500_000,
                         indicators={"i1": 6_000_000, "i2": 3_000_000,
                                     "i6": 1_000, "i7": 2_000_000,
                                     "i10": 7_000_000, "i13": 12_000_000,
                                     "i14": 13_000_000, "i15": 12_500_000,
                                     "i18": 500_000, "i20": 30 + i})

    app = FastAPI()
    app.include_router(router_mod.build_router(st))
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, st, db
    st.close()
    router_mod.reset_default_store()
    shutil.rmtree(tmp_path / "pages", ignore_errors=True)


def _page(client) -> str:
    r = client.get("/companii/%d-%s" % (CUI, SLUG), headers=CANON)
    assert r.status_code == 200, r.status_code
    return r.text


def test_renderer_is_exposed_where_takedown_probes_for_it(env):
    """takedown names the renderer it looks for; it must be there.

    The probe is the endpoint's only honest signal across the module
    boundary — if it reads False, an operator is told their annotate had
    no public effect.
    """
    mod_name, attr = takedown.ANNOTATION_RENDERER
    assert mod_name == "engine.public_ro.pages.templates"
    assert hasattr(templates, attr), (
        "takedown.ANNOTATION_RENDERER points at %s.%s, which does not "
        "exist — 'annotate' would be a silent no-op" % (mod_name, attr))
    assert takedown.page_layer_renders_annotations() is True


def test_annotate_changes_the_served_page(env):
    """The whole point: the page must not be byte-identical after."""
    client, _st, db = env
    before = _page(client)

    takedown.record_action(CUI, "annotate",
                           "figures disputed by the company",
                           "operator@cfo-ai.io",
                           note="Cifrele pentru 2024 sunt contestate.",
                           db_path=db)
    after = _page(client)

    assert after != before, (
        "the page is byte-identical after an 'annotate' — the operator "
        "was told the action succeeded while the disputed figures are "
        "still presented exactly as before")
    assert "Cifrele pentru 2024 sunt contestate." in after


def test_annotation_notice_never_leaks_private_audit_fields(env):
    """`verified_by` is a real person from the private audit trail.

    Publishing it on the very page this flow exists to protect would be
    a fresh personal-data disclosure, so only PUBLIC_NOTICE_FIELDS may
    reach the HTML.
    """
    client, _st, db = env
    takedown.record_action(CUI, "annotate", "internal reason string",
                           "operator@cfo-ai.io",
                           note="Date contestate.", db_path=db)
    html = _page(client)
    assert "operator@cfo-ai.io" not in html
    assert "internal reason string" not in html
    assert "Date contestate." in html


def test_annotation_with_no_note_renders_the_standing_label_only(env):
    """note is Optional. Absent stays absent — the page must not invent
    a sentence about the company to fill the box."""
    client, _st, db = env
    takedown.record_action(CUI, "annotate", "disputed", "op",
                           db_path=db)
    html = _page(client)
    assert templates.STRINGS["ro"]["notice_annotated"] in html
    assert "None" not in html.split("<footer>")[0]


def test_cached_page_does_not_survive_an_annotation(env):
    """The cache must not serve the pre-annotation bytes.

    Nothing in (cui, year, dataset_version, lang, percentiles_epoch,
    identity digest) moves when a takedown row is appended, so without
    the annotation in the key the notice would never reach a page that
    had already been rendered once — which is every page that matters.
    """
    client, _st, db = env
    first = _page(client)          # populates both cache tiers
    assert "notice" not in first or True

    takedown.record_action(CUI, "annotate", "disputed", "op",
                           note="Contestat.", db_path=db)
    second = _page(client)
    assert "Contestat." in second, (
        "the cached pre-annotation page was served after the annotation")

    # ...and clearing it again restores the plain page rather than
    # pinning the notice forever.
    takedown.record_action(CUI, "restore", "resolved", "op", db_path=db)
    third = _page(client)
    assert "Contestat." not in third


def test_removed_still_wins_over_annotated(env):
    """A later 'remove' must 410 regardless of an earlier annotation."""
    client, _st, db = env
    takedown.record_action(CUI, "annotate", "disputed", "op",
                           note="Contestat.", db_path=db)
    assert "Contestat." in _page(client)

    takedown.record_action(CUI, "remove", "verified removal", "op",
                           db_path=db)
    r = client.get("/companii/%d-%s" % (CUI, SLUG), headers=CANON,
                   follow_redirects=False)
    assert r.status_code == 410
