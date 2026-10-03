"""fx-feed — the BNR reference-rate feed, held on its REAL bytes.

INCIDENT (measured on production, 2026-10-03) — two facts, and they are not
the same fact:

  · THE ENGINE ENDPOINT. ``GET /api/fx-rates`` answered ``{"source":
    "fallback", "as_of": "2026-05-01", "stale": true}`` with RON 4.97 per EUR
    and USD 1.08 per EUR while BNR's file of 2026-10-02 says 5.3447 and
    4.7519 RON per USD. That wrong rate (7.5% high on EUR amounts, 3.3% on
    USD) reached ``/api/fx-rates``, ``/api/health`` and the EUR/USD briefing
    regeneration — nothing else.
  · WHAT A READER SAW. The browser does not read the engine endpoint: it asks
    the Supabase Edge Function ``fx-rates``, which asked the same dead address
    and served its last cached row, marked stale — RON 5.2489 per EUR as of
    2026-08-05. For two months EUR amounts were 1.8% too high
    (5.3447 / 5.2489) and USD amounts 4.5% too high (4.548 RON per USD served
    against 4.7519).

BNR had moved the feed: ``https://www.bnr.ro/nbrfxrates.xml`` answers a
redirect to an HTML page, the feed is at ``https://curs.bnr.ro/nbrfxrates.xml``
and its default namespace is ``https://www.bnr.ro/xsd`` (it was ``http://``).
Nothing failed loudly; ``/api/health`` said ``fx_rates: ok`` throughout; no
test read the feed's real bytes.

LAW (this file is the ENGINE's half; the browser's choice and the function's
source are held by the gate ``fx-browser``).
  The parser reads the real file (``fixtures/fx/nbrfxrates_REAL_curs_bnr_ro.xml``,
  BNR's own bytes of 2026-10-02, public data), in any namespace; a page that
  is not the feed is a FAILURE, never an answer; a body over 64 KB or one
  declaring a DOCTYPE / ENTITY is refused before it is parsed; a Cube whose
  date is missing, unparseable, in the future or more than 10 days old is a
  failure; every address is a candidate and the newest date wins; when none
  answers, the last accepted rate — else the bundled fallback — is served
  MARKED STALE, never a guess; a rate outside the plausible range is refused;
  ``?refresh=true`` is honoured for the operator bearer only;
  ``/api/health`` says ``fx_rates.ok: false`` whenever the engine serves
  anything but a current BNR rate, without turning the overall answer red;
  ``scripts/check_fx_live.py`` exits 0 only on a current BNR rate.

What it cannot see: whether BNR moves the feed again (the fixture is a
recording — ``scripts/check_fx_live.py`` inside the container is the live
reading); the deployed Edge Function (its source is tested by ``fx-browser``,
its deployment is the owner's step); what a browser shows.
Plant log: docs/engine_book/gates.md, "fx-feed".
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import re
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.api import _health, fx_rates

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "fx" / "nbrfxrates_REAL_curs_bnr_ro.xml"
REAL = FIXTURE.read_bytes()

NEW = "https://curs.bnr.ro/nbrfxrates.xml"
OLD = "https://www.bnr.ro/nbrfxrates.xml"

#: The day after the committed file was published. Every test runs on this
#: date unless it says otherwise — the freshness rule reads the clock at
#: ``fx_rates._today_ro`` and nowhere else.
TODAY = dt.date(2026, 10, 3)
T0 = 1_790_000_000.0   # an arbitrary epoch for the two memos

#: What the old address answers once its redirect is followed (first bytes,
#: measured 2026-10-03): a 200 that is a web page.
HTML_PAGE = (b'<!doctype html><html lang="ro">\r\n<head>\r\n    <meta charset="UTF-8">\r\n'
             b"    <title>BNR Banca Nationala a Romaniei (BNR)</title></head><body></body></html>")

#: The bundled fallback must stay within this distance of BNR's rate in the
#: committed file (the module's own rule: "update when they drift >5%").
FALLBACK_MAX_DISTANCE = 0.05


def _rate_in_file(currency: str) -> float:
    """The feed's own figure, read by a regex — not by the parser under test."""
    m = re.search(rb'<Rate currency="%s"(?: multiplier="(\d+)")?>([0-9.]+)</Rate>'
                  % currency.encode(), REAL)
    assert m, "the fixture carries no %s rate" % currency
    return float(m.group(2)) / (float(m.group(1)) if m.group(1) else 1.0)


def _dated(date: str, eur: bytes = b"5.3447") -> bytes:
    """The real file, re-dated (Cube and PublishingDate) and re-priced in EUR."""
    doc = REAL.replace(b"2026-10-02", date.encode())
    doc = doc.replace(b'<Rate currency="EUR">5.3447</Rate>',
                      b'<Rate currency="EUR">%s</Rate>' % eur)
    assert doc != REAL or (date == "2026-10-02" and eur == b"5.3447")
    return doc


def _assert_is_the_bundled_fallback(got) -> None:
    """Served fallback: marked stale, and within 5% of BNR's file — judged
    against the FILE, never against the module's own constants."""
    assert got["source"] == "fallback" and got["stale"] is True, got
    eur, usd = _rate_in_file("EUR"), _rate_in_file("USD")
    assert abs(got["rates"]["RON"] / eur - 1) <= FALLBACK_MAX_DISTANCE, got["rates"]
    assert abs(got["rates"]["USD"] / (eur / usd) - 1) <= FALLBACK_MAX_DISTANCE, got["rates"]
    assert got["rates"]["EUR"] == 1.0


class _Resp:
    def __init__(self, body: bytes, status: int = 200):
        self._body, self.status = body, status
        self.read_sizes = []

    def read(self, n: int = -1) -> bytes:
        self.read_sizes.append(n)
        return self._body if n is None or n < 0 else self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Wire:
    """The module's urlopen, replaced. Records every address and timeout."""

    def __init__(self, monkeypatch, answers):
        self.answers = dict(answers)
        self.calls = []
        self.timeouts = []
        self.responses = []

        def urlopen(req, timeout=None):
            url = getattr(req, "full_url", str(req))
            self.calls.append(url)
            self.timeouts.append(timeout)
            answer = self.answers[url]
            if isinstance(answer, Exception):
                raise answer
            resp = answer if isinstance(answer, _Resp) else _Resp(answer)
            self.responses.append(resp)
            return resp

        monkeypatch.setattr(fx_rates.urllib.request, "urlopen", urlopen)
        fx_rates.reset_fx_cache()


def _wire(monkeypatch, answers):
    """Replace the module's urlopen; return the list of addresses asked."""
    return _Wire(monkeypatch, answers).calls


@pytest.fixture(autouse=True)
def _pinned(monkeypatch):
    """A clean cache, the calendar on TODAY and the memo clock on T0."""
    monkeypatch.setattr(fx_rates, "_today_ro", lambda: TODAY)
    clock = {"t": T0}
    monkeypatch.setattr(fx_rates, "_now", lambda: clock["t"])
    fx_rates.reset_fx_cache()
    _health.reset_health_cache()
    yield clock
    fx_rates.reset_fx_cache()
    _health.reset_health_cache()


# ── the parser, on the feed's real bytes ────────────────────────────────


def test_the_real_feed_parses_to_the_figures_bnr_published():
    eur, usd = _rate_in_file("EUR"), _rate_in_file("USD")
    assert (eur, usd) == (5.3447, 4.7519), "the committed fixture is BNR's file of 2026-10-02"
    got = fx_rates._parse_bnr_xml(REAL)
    assert got["source"] == "BNR" and got["base"] == "EUR"
    assert got["as_of"] == "2026-10-02"
    assert got["rates"]["EUR"] == 1.0
    assert got["rates"]["RON"] == eur
    assert got["rates"]["USD"] == pytest.approx(eur / usd, rel=1e-12)


def test_the_real_feed_carries_the_https_namespace_the_parser_had_never_read():
    assert b'xmlns="https://www.bnr.ro/xsd"' in REAL
    assert b'xmlns="http://www.bnr.ro/xsd"' not in REAL


def test_the_pre_2026_namespace_still_parses():
    old_shape = REAL.replace(b'xmlns="https://www.bnr.ro/xsd"', b'xmlns="http://www.bnr.ro/xsd"')
    assert old_shape != REAL
    assert fx_rates._parse_bnr_xml(old_shape)["rates"]["RON"] == _rate_in_file("EUR")


@pytest.mark.parametrize("written", [
    b'xmlns="https://curs.bnr.ro/xsd"',      # where the file's own schemaLocation already points
    b"xmlns='https://www.bnr.ro/xsd'",       # the same namespace, single-quoted
    b'xmlns="urn:any:other"',                # one nobody has seen yet
    b"",                                     # none at all
], ids=["curs.bnr.ro", "single-quoted", "unknown", "no-namespace"])
def test_elements_are_matched_by_local_name_in_any_namespace(written):
    doc = REAL.replace(b'xmlns="https://www.bnr.ro/xsd"', written)
    assert doc != REAL
    got = fx_rates._parse_bnr_xml(doc)
    assert got["rates"]["RON"] == _rate_in_file("EUR") and got["as_of"] == "2026-10-02"


def test_a_multiplier_is_divided_out():
    quoted_per_100 = REAL.replace(b'<Rate currency="USD">4.7519</Rate>',
                                  b'<Rate currency="USD" multiplier="100">475.19</Rate>')
    assert quoted_per_100 != REAL
    assert fx_rates._parse_bnr_xml(quoted_per_100)["rates"]["USD"] == pytest.approx(
        5.3447 / 4.7519, rel=1e-9)


def test_a_web_page_is_not_the_feed():
    with pytest.raises(ValueError, match="DOCTYPE"):
        fx_rates._parse_bnr_xml(HTML_PAGE)
    # ...and a page that is well-formed XML with no DOCTYPE is still not it.
    with pytest.raises(ValueError, match="missing Body"):
        fx_rates._parse_bnr_xml(b"<html><head><title>BNR</title></head><body/></html>")


@pytest.mark.parametrize("old, planted, names", [
    # ten times: a multiplier nobody divided
    (b'<Rate currency="EUR">5.3447</Rate>', b'<Rate currency="EUR">53.447</Rate>', "RON per 1 EUR"),
    # the pair inverted
    (b'<Rate currency="EUR">5.3447</Rate>', b'<Rate currency="EUR">0.1871</Rate>', "RON per 1 EUR"),
    # USD ALONE is wrong, EUR untouched: only the USD bound can refuse these
    (b'<Rate currency="USD">4.7519</Rate>', b'<Rate currency="USD">47.519</Rate>', "USD per 1 EUR"),
    (b'<Rate currency="USD">4.7519</Rate>', b'<Rate currency="USD">0.47519</Rate>', "USD per 1 EUR"),
], ids=["eur-x10", "eur-inverted", "usd-x10", "usd-div10"])
def test_a_rate_outside_the_plausible_range_is_refused(old, planted, names):
    doc = REAL.replace(old, planted)
    assert doc != REAL
    with pytest.raises(ValueError, match="plausible") as refused:
        fx_rates._parse_bnr_xml(doc)
    assert names in str(refused.value)


@pytest.mark.parametrize("cube", [
    b"<Cube>",                        # no date at all
    b'<Cube date="">',
    b'<Cube date="02.10.2026">',      # a date, not in the feed's format
    b'<Cube date="2026-13-45">',      # the format, not a date
], ids=["missing", "empty", "dotted", "impossible"])
def test_a_cube_without_a_usable_date_is_not_the_feed(cube):
    """A dateless Cube used to be served FRESH with the fallback's date on a
    live rate. It is a failure: nothing can say how old the rate is."""
    doc = REAL.replace(b'<Cube date="2026-10-02">', cube)
    assert doc != REAL
    with pytest.raises(ValueError, match="no Cube with a date"):
        fx_rates._parse_bnr_xml(doc)


def test_of_two_cubes_the_newest_date_is_the_rate():
    older = b'<Cube date="2026-10-01"><Rate currency="EUR">5.0001</Rate><Rate currency="USD">4.5001</Rate></Cube>'
    for doc in (REAL.replace(b'<Cube date="2026-10-02">', older + b'<Cube date="2026-10-02">'),
                REAL.replace(b"</Cube></Body>", b"</Cube>" + older + b"</Body>")):
        assert doc != REAL
        got = fx_rates._parse_bnr_xml(doc)
        assert got["as_of"] == "2026-10-02" and got["rates"]["RON"] == 5.3447


@pytest.mark.parametrize("planted", [
    b'<!DOCTYPE DataSet [<!ENTITY a "5.3447">]>',
    b'<!doctype DataSet>',
    b'<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>',
], ids=["entity", "lowercase-doctype", "nested-entities"])
def test_a_body_declaring_a_doctype_or_an_entity_is_refused_before_it_is_parsed(monkeypatch, planted):
    doc = REAL.replace(b'<DataSet ', planted + b'<DataSet ')
    assert doc != REAL
    parsed = []
    real_fromstring = fx_rates.ET.fromstring
    monkeypatch.setattr(fx_rates.ET, "fromstring",
                        lambda text: parsed.append(1) or real_fromstring(text))
    with pytest.raises(ValueError, match="DOCTYPE or an ENTITY"):
        fx_rates._parse_bnr_xml(doc)
    assert parsed == [], "the XML parser was handed a body that declares a DOCTYPE / ENTITY"
    # the control: the real file DOES reach the parser through the same seam
    fx_rates._parse_bnr_xml(REAL)
    assert parsed == [1]


def test_a_body_over_64_kb_is_not_the_feed(monkeypatch):
    assert fx_rates._MAX_BODY_BYTES == 64 * 1024
    padded = REAL.replace(b"</DataSet>", b"<!--" + b"x" * (64 * 1024) + b"--></DataSet>")
    assert len(padded) > 64 * 1024
    with pytest.raises(ValueError, match="not the feed"):
        fx_rates._parse_bnr_xml(padded)
    # ...and the fetch never READS more than the cap plus one byte.
    wire = _Wire(monkeypatch, {NEW: padded, OLD: padded})
    got = fx_rates.get_fx_rates()
    assert wire.calls == [NEW, OLD]
    assert [r.read_sizes for r in wire.responses] == [[64 * 1024 + 1], [64 * 1024 + 1]]
    _assert_is_the_bundled_fallback(got)


def test_a_body_that_is_not_utf8_is_not_the_feed():
    with pytest.raises(ValueError):
        fx_rates._parse_bnr_xml(REAL.decode("utf-8").encode("utf-16"))


# ── freshness: the Cube's date against the calendar ─────────────────────


@pytest.mark.parametrize("cube_date, fresh", [
    ("2026-10-03", True),     # today's file
    ("2026-10-02", True),
    ("2026-09-23", True),     # exactly ten days
    ("2026-09-22", False),    # eleven
    ("2025-01-03", False),    # a file that stopped updating long ago
    ("2026-10-04", False),    # tomorrow
], ids=["today", "yesterday", "ten-days", "eleven-days", "frozen", "future"])
def test_a_cube_is_fresh_for_ten_days_and_never_from_the_future(monkeypatch, cube_date, fresh):
    doc = _dated(cube_date)
    calls = _wire(monkeypatch, {NEW: doc, OLD: doc})
    got = fx_rates.get_fx_rates()
    if fresh:
        assert got["source"] == "BNR" and got["stale"] is False and got["as_of"] == cube_date
    else:
        assert calls == [NEW, OLD], "an unacceptable date is a failure: the next address is asked"
        _assert_is_the_bundled_fallback(got)


def test_todays_file_ends_the_search(monkeypatch):
    calls = _wire(monkeypatch, {NEW: _dated("2026-10-03"), OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates()
    assert calls == [NEW], "nothing newer than today's file can exist; nothing else is asked"
    assert got["as_of"] == "2026-10-03" and got["stale"] is False


def test_a_frozen_first_address_loses_to_a_newer_second(monkeypatch):
    """The likeliest next failure after a move: the address keeps answering a
    file that stopped updating. Eight days old is still acceptable — and it
    still loses to the address that has yesterday's file."""
    calls = _wire(monkeypatch, {NEW: _dated("2026-09-25", eur=b"5.0001"), OLD: REAL})
    got = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD]
    assert got["as_of"] == "2026-10-02" and got["rates"]["RON"] == 5.3447
    assert got["source"] == "BNR" and got["stale"] is False


def test_an_older_second_address_never_replaces_the_first(monkeypatch):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: _dated("2026-09-25", eur=b"5.0001")})
    got = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD]
    assert got["as_of"] == "2026-10-02" and got["rates"]["RON"] == 5.3447


def test_on_the_same_date_the_first_address_wins(monkeypatch):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: _dated("2026-10-02", eur=b"5.1111")})
    got = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD] and got["rates"]["RON"] == 5.3447


# ── the fetch: which address, in which order, and what a non-feed means ──


def test_the_feed_is_asked_at_the_address_it_lives_at_first():
    assert fx_rates._BNR_URLS[0] == NEW
    assert OLD in fx_rates._BNR_URLS


def test_the_live_rate_is_served_and_not_marked_stale(monkeypatch):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates(force_refresh=True)
    # yesterday's file: the other address is asked, answers a page, changes nothing
    assert calls == [NEW, OLD]
    assert got["source"] == "BNR" and got["stale"] is False
    assert got["rates"]["RON"] == 5.3447 and got["as_of"] == "2026-10-02"
    assert got["rates"]["USD"] == pytest.approx(5.3447 / 4.7519, rel=1e-12)


def test_production_as_it_was_the_old_address_alone_serves_the_fallback(monkeypatch):
    """The engine half of the incident, reproduced: only the old address is
    known and it answers a web page. The answer must be the fallback MARKED
    STALE — and that is the whole of what the engine endpoint did for as long
    as the feed had moved."""
    monkeypatch.setattr(fx_rates, "_BNR_URLS", (OLD,))
    calls = _wire(monkeypatch, {OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [OLD]
    _assert_is_the_bundled_fallback(got)


def test_a_page_at_the_first_address_is_a_failure_and_the_next_is_tried(monkeypatch):
    calls = _wire(monkeypatch, {NEW: HTML_PAGE, OLD: REAL})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW, OLD]
    assert got["source"] == "BNR" and got["stale"] is False and got["rates"]["RON"] == 5.3447


def test_an_unreachable_first_address_falls_through_to_the_next(monkeypatch):
    calls = _wire(monkeypatch, {NEW: urllib.error.URLError("no route"), OLD: REAL})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW, OLD] and got["source"] == "BNR"


def test_no_address_answering_the_feed_serves_the_fallback_marked_stale(monkeypatch):
    calls = _wire(monkeypatch, {NEW: HTML_PAGE, OLD: urllib.error.URLError("down")})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW, OLD]
    _assert_is_the_bundled_fallback(got)
    # ...and inside the cooldown the answer costs no second fetch.
    again = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD] and again["stale"] is True


def test_an_implausible_feed_is_never_served(monkeypatch):
    doc = REAL.replace(b'<Rate currency="EUR">5.3447</Rate>', b'<Rate currency="EUR">53.447</Rate>')
    calls = _wire(monkeypatch, {NEW: doc, OLD: doc})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW, OLD]
    _assert_is_the_bundled_fallback(got)
    assert got["rates"]["RON"] != 53.447


@pytest.mark.parametrize("status", [204, 206, 301, 503])
def test_an_answer_that_is_not_200_is_a_failure_whatever_its_body(monkeypatch, status):
    """The body IS the real feed, so only the status check can refuse it."""
    calls = _wire(monkeypatch, {NEW: _Resp(REAL, status=status), OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD]
    _assert_is_the_bundled_fallback(got)


def test_every_fetch_carries_the_timeout(monkeypatch):
    """An urlopen with no timeout blocks a worker for as long as BNR hangs."""
    wire = _Wire(monkeypatch, {NEW: HTML_PAGE, OLD: REAL})
    fx_rates.get_fx_rates()
    assert wire.calls == [NEW, OLD]
    assert fx_rates._TIMEOUT_SECONDS == 8
    assert wire.timeouts == [8, 8], wire.timeouts


def test_the_bundled_fallback_is_within_five_percent_of_bnrs_file(monkeypatch):
    """The fallback's VALUES are pinned by the committed file, not by the
    module's own constants: 4.97 against BNR's 5.3447 was 7.5% off, past the
    module's own "update when >5%" rule, and nothing compared the two."""
    _wire(monkeypatch, {NEW: HTML_PAGE, OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates()
    _assert_is_the_bundled_fallback(got)
    served = dt.date.fromisoformat(got["as_of"])
    assert served <= dt.date(2026, 10, 2), "the fallback claims a date after the file it was taken from"
    assert dt.date(2026, 10, 2) - served <= dt.timedelta(days=366), got["as_of"]


# ── the two memos ───────────────────────────────────────────────────────


def test_inside_the_window_a_second_call_makes_no_fetch(monkeypatch, _pinned):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    first = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD] and first["stale"] is False
    _pinned["t"] = T0 + 23 * 3600
    again = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD], "a non-forced call inside the 24 h window refetched BNR"
    assert again["stale"] is False and again["rates"] == first["rates"]
    assert again["fetched_at"] == first["fetched_at"]
    _pinned["t"] = T0 + 25 * 3600
    fx_rates.get_fx_rates()
    assert calls == [NEW, OLD, NEW, OLD], "past the window the feed is asked again"


def test_after_the_window_a_failed_refetch_serves_the_last_rate_marked_stale(monkeypatch, _pinned):
    """The 'wrong rate served as fresh' class: the last accepted file, a day
    old, with BNR not answering, is NOT a current rate and must say so."""
    wire = _Wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    first = fx_rates.get_fx_rates()
    assert first["stale"] is False
    wire.answers = {NEW: urllib.error.URLError("down"), OLD: HTML_PAGE}
    _pinned["t"] = T0 + 25 * 3600
    late = fx_rates.get_fx_rates()
    assert wire.calls == [NEW, OLD, NEW, OLD]
    assert late["stale"] is True, "an expired rate was served as fresh after a failed refetch"
    assert late["source"] == "BNR" and late["as_of"] == "2026-10-02"
    assert late["rates"]["RON"] == 5.3447
    assert late["fetched_at"] == first["fetched_at"], "fetched_at must stay the time of the LAST GOOD fetch"


# ── the route: ?refresh=true is the operator's ──────────────────────────


@pytest.fixture(scope="module")
def app():
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app

    return create_app()


def test_an_anonymous_refresh_is_ignored_and_costs_no_fetch(app, monkeypatch):
    """Measured on the real app before this: five anonymous
    ``?refresh=true`` hits were five BNR fetches, ten with the feed down."""
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    client = TestClient(app)
    plain = client.get("/api/fx-rates")
    assert plain.status_code == 200 and calls == [NEW, OLD]
    for _ in range(5):
        forced = client.get("/api/fx-rates?refresh=true")
        assert forced.status_code == 200
        assert forced.json() == plain.json(), "the anonymous answer must be the plain route's"
    assert calls == [NEW, OLD], "an anonymous ?refresh=true reached BNR: %r" % calls[2:]


def test_an_anonymous_refresh_does_not_skip_the_failure_cooldown(app, monkeypatch):
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    calls = _wire(monkeypatch, {NEW: HTML_PAGE, OLD: HTML_PAGE})
    client = TestClient(app)
    for _ in range(5):
        body = client.get("/api/fx-rates?refresh=true").json()
        assert body["stale"] is True and body["source"] == "fallback"
    assert calls == [NEW, OLD], "the feed is down: one attempt per cooldown, whatever the query says"


def test_a_wrong_bearer_refreshes_nothing_and_is_not_refused(app, monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "operator-token-for-this-test")
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    client = TestClient(app)
    client.get("/api/fx-rates")
    r = client.get("/api/fx-rates?refresh=true", headers={"Authorization": "Bearer not-the-token"})
    assert r.status_code == 200 and r.json()["source"] == "BNR"
    assert calls == [NEW, OLD]


def test_the_operator_bearer_forces_a_refetch(app, monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "operator-token-for-this-test")
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    client = TestClient(app)
    client.get("/api/fx-rates")
    r = client.get("/api/fx-rates?refresh=true",
                   headers={"Authorization": "Bearer operator-token-for-this-test"})
    assert r.status_code == 200 and r.json()["stale"] is False
    assert calls == [NEW, OLD, NEW, OLD], "the operator's refresh must reach BNR"
    # ...and without the parameter the operator gets the memo like anyone else.
    client.get("/api/fx-rates", headers={"Authorization": "Bearer operator-token-for-this-test"})
    assert calls == [NEW, OLD, NEW, OLD]


# ── /api/health: what is being served, not only that something is ───────


def test_health_says_not_ok_while_the_fallback_is_served(monkeypatch):
    """Until 2026-10-03 this answered ok:true for as long as the fallback was
    being served — the check read fetched_at, which is 'now' for the fallback."""
    _wire(monkeypatch, {NEW: HTML_PAGE, OLD: HTML_PAGE})
    check = _health._check_fx_rates()
    assert check["ok"] is False, check
    assert check["source"] == "fallback" and check["stale"] is True
    assert dt.date.fromisoformat(check["as_of"]) <= dt.date(2026, 10, 2)


def test_health_says_ok_on_a_current_bnr_rate_and_carries_its_date(monkeypatch):
    _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    check = _health._check_fx_rates()
    assert check["ok"] is True, check
    assert (check["source"], check["stale"], check["as_of"]) == ("BNR", False, "2026-10-02")
    assert check["currencies"] == 3


def test_health_says_not_ok_on_a_last_known_rate_after_a_failed_refetch(monkeypatch, _pinned):
    wire = _Wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    assert _health._check_fx_rates()["ok"] is True
    wire.answers = {NEW: HTML_PAGE, OLD: HTML_PAGE}
    _pinned["t"] = T0 + 25 * 3600
    check = _health._check_fx_rates()
    assert check["ok"] is False and check["source"] == "BNR" and check["stale"] is True, check


def test_a_bnr_outage_does_not_turn_the_whole_health_answer_red(app, monkeypatch):
    """The overall ``ok`` and the status are the DATABASE's (the deploy lane
    reads ``ok`` and ``mode``; a 503 drains the container). Stripe is a
    warning and so is FX: ``checks.fx_rates.ok`` goes false, nothing else."""
    monkeypatch.setattr(_health, "_check_db", lambda: {"ok": True, "latency_ms": 0.0})
    monkeypatch.setattr(_health, "_check_stripe", lambda: {"ok": True, "latency_ms": 0.0})
    _wire(monkeypatch, {NEW: HTML_PAGE, OLD: HTML_PAGE})
    _health.reset_health_cache()
    r = TestClient(app).get("/api/health")
    body = r.json()
    assert body["checks"]["fx_rates"]["ok"] is False
    assert body["checks"]["fx_rates"]["source"] == "fallback"
    assert r.status_code == 200 and body["ok"] is True, (r.status_code, body["ok"])


# ── scripts/check_fx_live.py: the read-only post-deploy check ───────────


def _live_check():
    spec = importlib.util.spec_from_file_location("check_fx_live", REPO / "scripts" / "check_fx_live.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_the_live_check_passes_only_on_a_current_bnr_rate(monkeypatch, capsys):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    assert _live_check().main([]) == 0
    out = capsys.readouterr().out
    assert calls == [NEW, OLD], "the check must ask BNR itself (force_refresh), not read a memo"
    assert "FX-LIVE GREEN" in out and "5.3447" in out and "2026-10-02" in out and "4.7519" in out


def test_the_live_check_reds_when_the_feed_does_not_answer(monkeypatch, capsys):
    _wire(monkeypatch, {NEW: HTML_PAGE, OLD: urllib.error.URLError("down")})
    assert _live_check().main([]) == 1
    out = capsys.readouterr().out
    assert "FX-LIVE RED" in out and "source is 'fallback'" in out and "stale is True" in out


def test_the_live_check_does_not_pass_on_a_memo(monkeypatch, capsys):
    """A rate accepted earlier is in the memo; the feed has since died. The
    check forces the fetch, so it must red — not read the memo and pass."""
    wire = _Wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    assert fx_rates.get_fx_rates()["stale"] is False
    wire.answers = {NEW: HTML_PAGE, OLD: HTML_PAGE}
    assert _live_check().main([]) == 1
    assert "stale is True" in capsys.readouterr().out


@pytest.mark.parametrize("payload, names", [
    ({"source": "BNR", "stale": False, "as_of": "2026-09-22"}, "11 days old"),
    ({"source": "BNR", "stale": False, "as_of": "2026-10-04"}, "after today"),
    ({"source": "BNR", "stale": False, "as_of": None}, "not a date"),
    ({"source": "BNR", "stale": True, "as_of": "2026-10-02"}, "stale is True"),
    ({"source": "fallback", "stale": False, "as_of": "2026-10-02"}, "source is 'fallback'"),
], ids=["frozen", "future", "dateless", "stale", "fallback"])
def test_the_live_checks_own_judgement_holds_each_condition(payload, names):
    mod = _live_check()
    assert mod.MAX_AGE_DAYS == 10
    problems = mod.judge(payload, TODAY)
    assert len(problems) == 1 and names in problems[0], problems
    assert mod.judge({"source": "BNR", "stale": False, "as_of": "2026-09-23"}, TODAY) == []
