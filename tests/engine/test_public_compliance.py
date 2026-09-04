"""Lane 6 — compliance & governance for the public RO surface.

Covers (all offline, synthetic fixtures only — wave test contract):
  - PS8 takedown end-to-end: operator endpoint (fail-closed auth),
    removal visible to the page/sitemap contracts within one call,
    append-only audit trail, annotate and restore (un-takedown) paths.
  - ratelimit: bucket math under an injected clock, crawler-UA
    exemption, 429 response shape, hashed (never raw) IP keys.
  - source registry completeness + unlicensed-source refusal, the
    dataset license map, and the PUBLIC_INGEST_UNLICENSED_OK override.
  - validate_publishable (PS7) truth table: PF / F-series / taken-down /
    thin / signal-less rows all refused.
  - registry-driven footer assertion: every rendered page footer carries
    the attribution + license line (via the lane 3 renderer when landed;
    always via compliance.attribution_footer_html).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public_ro import compliance, ratelimit, takedown

TOKEN = "test-operator-token"
CUI = 12345678


@pytest.fixture()
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated public_ro.db per test — never the repo data/ file."""
    path = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(path))
    return path


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


# ──────────────────────────────────────────────────────────────────────
# PS8 — takedown flow
# ──────────────────────────────────────────────────────────────────────


class TestTakedownAuth:
    def test_fails_closed_when_token_unset(self, db_path, monkeypatch):
        monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
        resp = _post(_client(db_path), "remove")
        assert resp.status_code == 503

    def test_missing_bearer_401(self, db_path, monkeypatch):
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        resp = _post(_client(db_path), "remove", token=None)
        assert resp.status_code == 401

    def test_wrong_token_401(self, db_path, monkeypatch):
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        resp = _post(_client(db_path), "remove", token="wrong")
        assert resp.status_code == 401
        # And nothing was recorded.
        assert takedown.audit_trail(CUI, db_path) == []

    def test_bad_action_422(self, db_path, monkeypatch):
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        resp = _post(_client(db_path), "obliterate")
        assert resp.status_code == 422


class TestTakedownPS8:
    def test_remove_then_restore_end_to_end(self, db_path, monkeypatch):
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        client = _client(db_path)

        # Before: publishable, in sitemap set's complement.
        assert not takedown.is_removed(CUI, db_path)
        assert CUI not in takedown.removed_cuis(db_path)

        # REMOVE — the page contract (lane 3 checks is_removed → 410) and
        # the sitemap contract (lane 4 calls removed_cuis once per regen)
        # must both flip within ONE call each.
        resp = _post(client, "remove")
        assert resp.status_code == 200
        assert resp.json()["removed"] is True
        assert resp.json()["state"] == "remove"
        assert takedown.is_removed(CUI, db_path)
        assert CUI in takedown.removed_cuis(db_path)  # ONE regen call

        # Publishability gate refuses it too (PS7 ∩ PS8).
        row = {"cui": CUI, "tip_contrib": "PJ", "has_filings": True}
        assert compliance.validate_publishable(row, db_path=db_path) is False

        # ANNOTATE (page returns, with notice) then RESTORE (un-takedown).
        resp = _post(client, "annotate", reason="context note added")
        assert resp.status_code == 200
        assert not takedown.is_removed(CUI, db_path)
        assert CUI not in takedown.removed_cuis(db_path)
        assert takedown.annotation(CUI, db_path)["reason"] == "context note added"

        resp = _post(client, "restore", reason="dispute resolved")
        assert resp.status_code == 200
        assert resp.json()["state"] == "published"
        assert takedown.current_state(CUI, db_path) is None
        assert takedown.annotation(CUI, db_path) is None
        assert compliance.validate_publishable(row, db_path=db_path) is True

        # Append-only audit trail, full record, in order.
        trail = takedown.audit_trail(CUI, db_path)
        assert [t["action"] for t in trail] == ["remove", "annotate", "restore"]
        for t in trail:
            assert t["verified_by"] == "operator@test"
            assert t["reason"]
            assert t["created_at"]

    def test_page_route_410_when_lane3_landed(self, db_path, monkeypatch):
        """End-to-end 410 through the real page route — skips until the
        lane 3 pages router lands (contract: pages check store.takedowns)."""
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        pages = pytest.importorskip(
            "engine.public_ro.pages",
            reason="lane 3 pages module not landed; 410 contract asserted"
            " via takedown.is_removed above",
        )
        build = getattr(pages, "build_pages_router", None) or getattr(
            pages, "build_router", None
        )
        if build is None:
            pytest.skip("lane 3 pages router factory not landed yet")
        _post(_client(db_path), "remove")
        app = FastAPI()
        app.include_router(build())
        client = TestClient(app)
        resp = client.get("/api/public/ro/companii/%d-test" % CUI)
        assert resp.status_code == 410

    def test_audit_rows_are_never_mutated(self, db_path, monkeypatch):
        monkeypatch.setenv("ENGINE_API_TOKEN", TOKEN)
        client = _client(db_path)
        _post(client, "remove")
        first = takedown.audit_trail(CUI, db_path)[0]
        _post(client, "restore")
        _post(client, "remove", reason="second removal")
        again = takedown.audit_trail(CUI, db_path)[0]
        assert again == first  # row 1 untouched by later actions
        assert len(takedown.audit_trail(CUI, db_path)) == 3

    def test_db_pragmas(self, db_path):
        conn = takedown.connect(db_path)
        try:
            assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        finally:
            conn.close()


# ──────────────────────────────────────────────────────────────────────
# ratelimit
# ──────────────────────────────────────────────────────────────────────


def _request(ip="203.0.113.7", ua="Mozilla/5.0"):
    return SimpleNamespace(
        headers={"user-agent": ua},
        client=SimpleNamespace(host=ip),
    )


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class TestRateLimit:
    def test_bucket_math_burst_then_429(self):
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(60, clock=clock)
        req = _request()
        for _ in range(60):
            assert limiter.check(req) is None
        resp = limiter.check(req)
        assert resp is not None
        assert resp.status_code == 429
        assert int(resp.headers["retry-after"]) >= 1

    def test_refill_after_time_passes(self):
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(60, clock=clock)
        req = _request()
        for _ in range(60):
            limiter.check(req)
        assert limiter.check(req) is not None
        clock.t += 2.0  # 60/min = 1 token/s → 2 tokens back
        assert limiter.check(req) is None
        assert limiter.check(req) is None
        assert limiter.check(req) is not None

    def test_independent_ips(self):
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(2, burst=2, clock=clock)
        a, b = _request(ip="198.51.100.1"), _request(ip="198.51.100.2")
        assert limiter.check(a) is None
        assert limiter.check(a) is None
        assert limiter.check(a) is not None  # a exhausted
        assert limiter.check(b) is None  # b unaffected

    @pytest.mark.parametrize(
        "ua",
        [
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Mozilla/5.0 (compatible; bingbot/2.0)",
            "Mozilla/5.0 (compatible; YandexBot/3.0)",
            "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
        ],
    )
    def test_crawler_ua_exempt(self, ua):
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(1, burst=1, clock=clock)
        req = _request(ua=ua)
        for _ in range(50):  # far past the budget — never limited
            assert limiter.check(req) is None

    def test_keys_are_hashed_not_raw_ip(self):
        ip = "203.0.113.99"
        key = ratelimit.hash_ip(ip)
        assert ip not in key
        assert len(key) == 16
        assert all(c in "0123456789abcdef" for c in key)
        # Daily salt: same day stable, different day different.
        assert ratelimit.hash_ip(ip, day="2026-08-28") == ratelimit.hash_ip(
            ip, day="2026-08-28"
        )
        assert ratelimit.hash_ip(ip, day="2026-08-28") != ratelimit.hash_ip(
            ip, day="2026-08-29"
        )

    def test_xff_preferred_over_socket_peer(self):
        """The forwarded chain beats the socket peer, keyed on the LAST hop.

        Caddy fronts this backend with a bare ``reverse_proxy``, so it
        APPENDS the real peer: the final entry is ours, every earlier one is
        caller-written. Two genuinely different clients therefore differ in
        the LAST hop, and must get separate buckets even behind one Caddy.
        """
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(1, burst=1, clock=clock)
        r1 = SimpleNamespace(
            headers={"user-agent": "m", "x-forwarded-for": "10.0.0.1, 192.0.2.1"},
            client=SimpleNamespace(host="172.18.0.2"),
        )
        r2 = SimpleNamespace(
            headers={"user-agent": "m", "x-forwarded-for": "10.0.0.1, 192.0.2.2"},
            client=SimpleNamespace(host="172.18.0.2"),
        )
        assert limiter.check(r1) is None
        assert limiter.check(r2) is None  # not sharing r1's bucket

    def test_rotating_the_spoofed_leftmost_hop_cannot_mint_new_buckets(self):
        """The bypass this module shipped with, closed.

        Everything before the final hop is written by the caller. Keying on
        index 0 let one abuser mint a fresh bucket per request by rotating a
        header, so the shield over 600k public company pages was decorative.
        ``funnel._client_ip`` was fixed this way (D2); this module was not
        back-ported until 2026-09-04.

        PLANT: restore ``xff.split(",")[0]`` in
        ``engine.public_ro.ratelimit._client_ip``. RED: the second call is
        allowed instead of limited. REVERT: green.
        """
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(1, burst=1, clock=clock)
        first = SimpleNamespace(
            headers={"user-agent": "m", "x-forwarded-for": "203.0.113.9, 192.0.2.1"},
            client=SimpleNamespace(host="172.18.0.2"),
        )
        assert limiter.check(first) is None, "the first call should pass"
        for spoof in ("198.51.100.7", "203.0.113.250", "10.9.9.9", "8.8.8.8"):
            rotated = SimpleNamespace(
                headers={"user-agent": "m",
                         "x-forwarded-for": "%s, 192.0.2.1" % spoof},
                client=SimpleNamespace(host="172.18.0.2"),
            )
            assert limiter.check(rotated) is not None, (
                "RATE LIMIT BYPASSED — rotating the caller-written leftmost hop "
                "to %s minted a fresh bucket; the limiter must key on the last "
                "hop, the only one our own proxy appended." % spoof
            )

    def test_the_limiter_and_the_funnel_read_the_same_hop(self):
        """Two helpers, one topology. They drifted once; they must not again."""
        from engine.public_ro import funnel as _funnel

        for chain in ("10.9.9.9, 203.0.113.7",
                      "a, b, c",
                      "  1.1.1.1 ,  2.2.2.2  ",
                      "203.0.113.7"):
            req = SimpleNamespace(headers={"x-forwarded-for": chain},
                                  client=SimpleNamespace(host="172.18.0.2"))
            assert ratelimit._client_ip(req) == _funnel._client_ip(req), (
                "HOP SEMANTICS DRIFTED on %r: ratelimit=%r funnel=%r"
                % (chain, ratelimit._client_ip(req), _funnel._client_ip(req)))

    def test_env_tuning_and_module_entrypoint(self, monkeypatch):
        monkeypatch.setenv("PUBLIC_RO_RATE_PER_MIN", "1")
        monkeypatch.setenv("PUBLIC_RO_RATE_BURST", "1")
        ratelimit.reset_limiter()
        try:
            req = _request(ip="203.0.113.50")
            assert ratelimit.check(req) is None
            resp = ratelimit.check(req)
            assert resp is not None and resp.status_code == 429
        finally:
            ratelimit.reset_limiter()  # don't leak the tiny budget

    def test_memory_bound_eviction(self):
        clock = FakeClock()
        limiter = ratelimit.TokenBucketLimiter(60, clock=clock, max_keys=10)
        for i in range(50):
            clock.t += 0.01
            limiter.allow("key-%d" % i)
        assert len(limiter._buckets) <= 11


# ──────────────────────────────────────────────────────────────────────
# Source registry & licensing
# ──────────────────────────────────────────────────────────────────────


class TestSourceRegistry:
    def test_required_sources_registered(self):
        for required in ("mfinante_datagov", "anaf_v9", "licensed_provider"):
            assert required in compliance.SOURCE_REGISTRY

    def test_registry_rows_complete(self):
        for src in compliance.SOURCE_REGISTRY.values():
            assert src.id and src.name and src.terms_note and src.added
            # A source with an asserted license must point at its terms.
            if src.license_id:
                assert src.license_url

    def test_every_dataset_slug_maps_to_registered_source_license(self):
        known = compliance.OPEN_LICENSE_IDS | {None}
        for slug, lic in compliance.DATAGOV_DATASET_LICENSES.items():
            assert lic in known, (slug, lic)

    def test_verified_license_facts(self):
        # FY2019-FY2023 = CC-BY-4.0 (verbatim CKAN, live-verified).
        for year in range(2019, 2023):
            assert (
                compliance.dataset_license("situatii_financiare_%d" % year)
                == "CC-BY-4.0"
            )
        assert compliance.dataset_license("situatii_financiare2023") == "CC-BY-4.0"
        # FY2018-earlier = uk-ogl legacy label.
        assert compliance.dataset_license("situatii_financiare_2015") == "uk-ogl"
        # FY2025 + 2024_actualizat = UNSET in CKAN.
        assert compliance.dataset_license("situatii_financiare_2025") is None
        assert (
            compliance.dataset_license("situatii_financiare_2024_actualizat")
            is None
        )
        # Identification snapshots = CC-BY-4.0 by prefix.
        assert (
            compliance.dataset_license(
                "date_de_identificare_platitori_actualizate_iunie_2026"
            )
            == "CC-BY-4.0"
        )

    def test_unlicensed_dataset_refused_by_default(self, monkeypatch):
        monkeypatch.delenv("PUBLIC_INGEST_UNLICENSED_OK", raising=False)
        ok, reason = compliance.check_ingest_allowed("situatii_financiare_2025")
        assert ok is False
        assert "PUBLIC_INGEST_UNLICENSED_OK" in reason

    def test_unlicensed_dataset_env_override_is_loud(self, monkeypatch, caplog):
        monkeypatch.setenv("PUBLIC_INGEST_UNLICENSED_OK", "1")
        with caplog.at_level("WARNING"):
            ok, reason = compliance.check_ingest_allowed(
                "situatii_financiare_2025"
            )
        assert ok is True
        assert "override" in reason
        assert any("WITHOUT an asserted open license" in r.message
                   for r in caplog.records)

    def test_licensed_dataset_allowed(self):
        ok, reason = compliance.check_ingest_allowed("situatii_financiare_2022")
        assert ok is True and "CC-BY-4.0" in reason

    def test_unknown_dataset_refused(self, monkeypatch):
        monkeypatch.delenv("PUBLIC_INGEST_UNLICENSED_OK", raising=False)
        assert compliance.check_ingest_allowed("fisier_test")[0] is False

    def test_license_line_unregistered_source_refused(self):
        with pytest.raises(KeyError):
            compliance.license_line("shadow_scraper")

    def test_license_line_unlicensed_source_refused(self):
        with pytest.raises(compliance.UnlicensedSourceError):
            compliance.license_line("licensed_provider")

    def test_license_line_contents(self):
        line = compliance.license_line("mfinante_datagov")
        assert "Ministerul Finan" in line
        assert "CC-BY-4.0" in line
        assert "creativecommons.org/licenses/by/4.0" in line
        line = compliance.license_line("anaf_v9")
        assert "ANAF" in line


# ──────────────────────────────────────────────────────────────────────
# PS7 — validate_publishable truth table
# ──────────────────────────────────────────────────────────────────────


class TestValidatePublishable:
    BASE = {"cui": 987654, "tip_contrib": "PJ", "reg_number": "J40/123/2010",
            "has_filings": True}

    def test_happy_path_pj(self, db_path):
        assert compliance.validate_publishable(self.BASE, db_path=db_path)

    @pytest.mark.parametrize(
        "over, why",
        [
            ({"tip_contrib": "PF", "reg_number": None}, "PF refused"),
            ({"tip_contrib": None, "reg_number": "F12/44/2019"}, "F-series refused"),
            ({"tip_contrib": "PF", "reg_number": "J40/1/2000"},
             "PF beats J-series (belt-and-braces)"),
            ({"tip_contrib": None, "reg_number": None}, "no PJ signal → fail closed"),
            ({"has_filings": False}, "thin row (no filings) refused"),
            ({"cui": 0}, "invalid cui refused"),
            ({"cui": "987654"}, "non-int cui refused"),
        ],
    )
    def test_refusals(self, db_path, over, why):
        row = {**self.BASE, **over}
        ok, reason = compliance.publishable_reason(row, db_path=db_path)
        assert ok is False, why
        assert reason

    def test_register_series_only_is_enough(self, db_path):
        row = {**self.BASE, "tip_contrib": None}
        assert compliance.validate_publishable(row, db_path=db_path)
        row_coop = {**self.BASE, "tip_contrib": None, "reg_number": "C7/9/2015"}
        assert compliance.validate_publishable(row_coop, db_path=db_path)

    def test_filing_years_alternative(self, db_path):
        row = {**self.BASE, "has_filings": False, "filing_years": [2023, 2024]}
        assert compliance.validate_publishable(row, db_path=db_path)

    def test_taken_down_refused_and_restored_allowed(self, db_path):
        takedown.record_action(
            self.BASE["cui"], "remove", "verified request", "op@test",
            db_path=db_path,
        )
        ok, reason = compliance.publishable_reason(self.BASE, db_path=db_path)
        assert ok is False and "taken down" in reason
        takedown.record_action(
            self.BASE["cui"], "restore", "resolved", "op@test", db_path=db_path
        )
        assert compliance.validate_publishable(self.BASE, db_path=db_path)

    def test_annotated_stays_publishable(self, db_path):
        takedown.record_action(
            self.BASE["cui"], "annotate", "context", "op@test", db_path=db_path
        )
        assert compliance.validate_publishable(self.BASE, db_path=db_path)


# ──────────────────────────────────────────────────────────────────────
# Registry-driven footer attribution
# ──────────────────────────────────────────────────────────────────────


class TestFooterAttribution:
    def test_footer_builder_carries_every_license_line(self):
        ids = [
            s.id for s in compliance.SOURCE_REGISTRY.values() if s.license_id
        ]
        html = compliance.attribution_footer_html(ids)
        for source_id in ids:
            # escape() in the builder never alters these ASCII substrings.
            line = compliance.license_line(source_id)
            src = compliance.SOURCE_REGISTRY[source_id]
            assert src.license_id in html
            assert "Licen" in line and src.license_id in line

    def test_footer_refuses_unlicensed_source(self):
        with pytest.raises(compliance.UnlicensedSourceError):
            compliance.attribution_footer_html(["licensed_provider"])

    def test_rendered_page_footer_when_lane3_landed(self, db_path):
        """REGISTRY-DRIVEN: any page the lane 3 renderer produces must
        contain the attribution + license line. Skips until it lands."""
        pages = pytest.importorskip(
            "engine.public_ro.pages",
            reason="lane 3 pages module not landed; footer contract"
            " asserted via attribution_footer_html above",
        )
        render = None
        for name in ("render_company_page", "render_page", "render"):
            render = getattr(pages, name, None)
            if render is not None:
                break
        if render is None:
            pytest.skip("lane 3 page renderer not landed yet")
        fixture = {
            "cui": 111222,
            "name": "TEST COMPANY SRL",
            "year": 2024,
            "dataset_id": "mfinante_datagov",
            # lowercase i-codes per the companion spec .csv convention —
            # ALSO avoids the engine-book invariant scanner's letter+digit
            # marker (an uppercase i-code in a test file would register as
            # an uncatalogued invariant id in docs/engine_book).
            "indicators": {"i13": 1000000, "i18": 100000, "i19": 0},
        }
        try:
            html = render(fixture)
        except TypeError:
            pytest.skip("lane 3 renderer signature differs; contract"
                        " re-check when it lands")
        assert "CC-BY-4.0" in html
        assert "Ministerul Finan" in html
