"""PS8 takedown defects — sitemap invalidation and the honest 'annotate'.

Two confirmed defects in engine.public_ro.takedown:

  D1. A takedown appended its audit row, returned removed:true, and
      touched NOTHING else. It never regenerated the sitemap shards and
      never dropped seo's served-file cache, and seo.regenerate() has
      exactly one caller in the repo (scripts/public_seo.py) — so unless
      an operator happened to run that script, the removed company's URL
      kept being handed to crawlers indefinitely. "Honored immediately"
      has to include the sitemap.

  D2. 'annotate' was a silent no-op on every serving surface while the
      API reported success: takedown.annotation() had ZERO consumers in
      src/, so an operator who resolved a dispute with the softer action
      got 200 {ok:true, state:"annotate"} and a byte-identical page.

The page/template wiring for D2 lives in another lane; what is asserted
here is the half this module owns — one clean predicate carrying a
public-safe notice, a cache-key component the page layer can key on, and
an endpoint that refuses to claim a public effect it cannot see.
"""

from __future__ import annotations

import gzip
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public_ro import seo, takedown

TOKEN = "test-operator-token"
CUI = 12345678
OTHER_CUI = 87654321


# ── fixtures ───────────────────────────────────────────────────────────


class _FakeStore:
    """Minimal lane-2 store contract used by seo.generate_sitemaps."""

    def __init__(self, cuis: List[int]) -> None:
        self._cuis = list(cuis)

    def publishable_companies(self) -> List[Dict[str, Any]]:
        return [{"cui": c, "name": "Company %d" % c, "years": [2024]}
                for c in self._cuis]

    def hub_keys(self, kind: str) -> List[Dict[str, Any]]:
        return []

    def dataset_version(self) -> Dict[str, Any]:
        return {"version": "v-test", "fetch_date": "2026-01-31"}


@pytest.fixture()
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(path))
    monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
    return path


@pytest.fixture()
def sitemaps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A generated sitemap on disk carrying BOTH company URLs."""
    out = tmp_path / "public_sitemaps"
    monkeypatch.setenv("PUBLIC_SITEMAP_DIR", str(out))
    store = _FakeStore([CUI, OTHER_CUI])
    # regenerate() resolves the store itself; point it at the fake one so
    # a URL leaving the shard can only be the takedown filter's doing.
    monkeypatch.setattr(seo, "_open_default_store", lambda: store)
    seo._cached_file.cache_clear()
    seo.generate_sitemaps(store, out_dir=out)
    return out


def _client(db_path: Path) -> TestClient:
    app = FastAPI()
    app.include_router(takedown.build_takedown_router(db_path))
    return TestClient(app)


def _post(client: TestClient, action: str, token: Optional[str] = TOKEN, **over):
    body = {
        "cui": CUI,
        "action": action,
        "reason": "verified rightsholder request",
        "verified_by": "operator@test",
    }
    body.update(over)
    headers = {"Authorization": "Bearer %s" % token} if token else {}
    return client.post("/api/public/ro/takedown", json=body, headers=headers)


def _shard_urls(out: Path) -> List[str]:
    urls: List[str] = []
    for path in sorted(out.glob("companies-*.xml.gz")):
        xml = gzip.decompress(path.read_bytes()).decode("utf-8")
        urls.extend(re.findall(r"<loc>(.*?)</loc>", xml))
    return urls


# ──────────────────────────────────────────────────────────────────────
# D1 — a takedown must invalidate the already-generated sitemap
# ──────────────────────────────────────────────────────────────────────


class TestSitemapHonoredImmediately:
    def test_remove_drops_the_url_from_the_generated_shard(
        self, db_path: Path, sitemaps: Path
    ) -> None:
        before = _shard_urls(sitemaps)
        assert any("/%d-" % CUI in u for u in before)
        assert any("/%d-" % OTHER_CUI in u for u in before)

        resp = _post(_client(db_path), "remove")
        assert resp.status_code == 200
        assert resp.json()["removed"] is True

        after = _shard_urls(sitemaps)
        assert not any("/%d-" % CUI in u for u in after), (
            "removed company still advertised to crawlers in the shard"
        )
        assert any("/%d-" % OTHER_CUI in u for u in after)
        assert resp.json()["sitemap_refresh"]["status"] == "ok"

    def test_served_file_cache_is_dropped(
        self, db_path: Path, sitemaps: Path
    ) -> None:
        shard = sorted(sitemaps.glob("companies-*.xml.gz"))[0]
        primed = seo._read_generated(shard)
        assert primed is not None
        assert seo._cached_file.cache_info().currsize >= 1

        _post(_client(db_path), "remove")

        assert seo._cached_file.cache_info().currsize == 0, (
            "seo's served-file cache still holds the pre-takedown bytes"
        )
        served = gzip.decompress(seo._read_generated(shard)).decode("utf-8")
        assert "/%d-" % CUI not in served

    def test_restore_puts_the_url_back(
        self, db_path: Path, sitemaps: Path
    ) -> None:
        client = _client(db_path)
        _post(client, "remove")
        assert not any("/%d-" % CUI in u for u in _shard_urls(sitemaps))
        _post(client, "restore", reason="dispute resolved")
        assert any("/%d-" % CUI in u for u in _shard_urls(sitemaps))

    def test_sitemap_failure_never_fails_the_takedown_but_is_surfaced(
        self,
        db_path: Path,
        sitemaps: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        def _boom(*a: Any, **k: Any) -> Dict[str, Any]:
            raise RuntimeError("shard dir is read-only")

        monkeypatch.setattr(seo, "regenerate", _boom)
        with caplog.at_level(logging.ERROR, logger="engine.public_ro.takedown"):
            resp = _post(_client(db_path), "remove")

        # The 410 half is load-bearing and must still land.
        assert resp.status_code == 200
        assert resp.json()["removed"] is True
        assert takedown.is_removed(CUI, db_path)
        # ...but the failure is never swallowed.
        refresh = resp.json()["sitemap_refresh"]
        assert refresh["status"] == "failed"
        assert "read-only" in refresh["reason"]
        assert any("read-only" in r.getMessage() for r in caplog.records)

    def test_no_generated_sitemap_is_skipped_not_invented(
        self, db_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A host that has never generated a sitemap has nothing to
        invalidate; the takedown must not publish one as a side effect."""
        out = tmp_path / "never_generated"
        monkeypatch.setenv("PUBLIC_SITEMAP_DIR", str(out))
        resp = _post(_client(db_path), "remove")
        assert resp.status_code == 200
        assert resp.json()["sitemap_refresh"]["status"] == "skipped"
        assert not out.exists()


# ──────────────────────────────────────────────────────────────────────
# D2 — 'annotate' must not be advertised as having a public effect
# ──────────────────────────────────────────────────────────────────────


class TestAnnotateContractIsHonest:
    def test_annotation_carries_a_public_safe_notice(
        self, db_path: Path
    ) -> None:
        _post(_client(db_path), "annotate", reason="figures disputed",
              note="Company states the 2024 revenue line is misfiled.")
        ann = takedown.annotation(CUI, db_path)
        assert ann is not None
        notice = ann["public_notice"]
        assert notice["cui"] == CUI
        assert notice["note"] == "Company states the 2024 revenue line is misfiled."
        assert notice["created_at"]
        # The private half of the audit trail must never reach a page.
        assert "verified_by" not in notice
        assert "operator@test" not in str(notice)
        assert "reason" not in notice

    def test_absent_note_stays_none(self, db_path: Path) -> None:
        _post(_client(db_path), "annotate", reason="under review")
        notice = takedown.annotation(CUI, db_path)["public_notice"]
        assert notice["note"] is None  # absent != "" and != a made-up sentence

    def test_response_refuses_to_claim_an_unrendered_effect(
        self, db_path: Path, monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setattr(
            takedown, "page_layer_renders_annotations", lambda: False)
        with caplog.at_level(logging.WARNING, logger="engine.public_ro.takedown"):
            resp = _post(_client(db_path), "annotate", reason="figures disputed")
        body = resp.json()
        assert body["state"] == "annotate"
        assert body["public_effect"] == takedown.PUBLIC_EFFECT_NOT_RENDERED
        assert body["public_effect_detail"]
        assert any("annotate" in r.getMessage() for r in caplog.records)

    def test_response_reports_the_effect_once_the_renderer_is_wired(
        self, db_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            takedown, "page_layer_renders_annotations", lambda: True)
        body = _post(_client(db_path), "annotate").json()
        assert body["public_effect"] == takedown.PUBLIC_EFFECT_RENDERED
        assert body["public_effect_detail"] is None

    def test_renderer_probe_is_false_until_the_page_lane_lands_the_hook(
        self,
    ) -> None:
        mod_name, attr = takedown.ANNOTATION_RENDERER
        import importlib

        mod = importlib.import_module(mod_name)
        expected = callable(getattr(mod, attr, None))
        assert takedown.page_layer_renders_annotations() is expected

    def test_remove_and_restore_report_their_real_effects(
        self, db_path: Path
    ) -> None:
        client = _client(db_path)
        assert (_post(client, "remove").json()["public_effect"]
                == takedown.PUBLIC_EFFECT_REMOVED)
        assert (_post(client, "restore", reason="resolved").json()["public_effect"]
                == takedown.PUBLIC_EFFECT_PUBLISHED)

    def test_state_version_moves_on_every_action(self, db_path: Path) -> None:
        """The page cache key is (cui, year, dataset_version, lang,
        percentiles_epoch) — none of which an annotate changes. Without a
        state component the notice can never reach an already-cached
        page."""
        assert takedown.state_version(CUI, db_path) == 0
        client = _client(db_path)
        v1 = _post(client, "annotate").json()["state_version"]
        assert v1 == takedown.state_version(CUI, db_path) > 0
        v2 = _post(client, "restore", reason="resolved").json()["state_version"]
        assert v2 > v1
        assert takedown.state_version(OTHER_CUI, db_path) == 0


# ──────────────────────────────────────────────────────────────────────
# apply_action is the single authority for a public-state change
# ──────────────────────────────────────────────────────────────────────


class TestApplyActionAuthority:
    def test_non_http_callers_get_the_same_honoring(
        self, db_path: Path, sitemaps: Path
    ) -> None:
        result = takedown.apply_action(
            CUI, "remove", "verified rightsholder request", "operator@test",
            db_path=db_path,
        )
        assert result["removed"] is True
        assert result["sitemap_refresh"]["status"] == "ok"
        assert not any("/%d-" % CUI in u for u in _shard_urls(sitemaps))

    def test_record_action_stays_the_pure_audit_primitive(
        self, db_path: Path, sitemaps: Path
    ) -> None:
        takedown.record_action(
            CUI, "remove", "audit only", "operator@test", db_path=db_path)
        # record_action honors nothing by design; the shard is untouched.
        assert any("/%d-" % CUI in u for u in _shard_urls(sitemaps))
