"""fx-feed — the BNR reference-rate feed, held on its REAL bytes.

INCIDENT (measured on production, 2026-10-03). ``GET /api/fx-rates`` answered
``{"source": "fallback", "as_of": "2026-05-01", "stale": true}`` with
RON 4.97 per EUR while BNR published 5.3447: every amount a reader switched to
EUR was 7.5% too high (USD 3.3%). BNR had moved the feed —
``https://www.bnr.ro/nbrfxrates.xml`` answers a redirect to an HTML page, the
feed is at ``https://curs.bnr.ro/nbrfxrates.xml`` and its default namespace is
``https://www.bnr.ro/xsd`` (it was ``http://``). Nothing failed loudly: the
HTML did not parse, the bundled fallback was served, one WARNING per five
minutes went to the log. No test read the feed's real bytes.

LAW. The parser reads the real file (``fixtures/fx/nbrfxrates_REAL_curs_bnr_ro.xml``,
BNR's own bytes of 2026-10-02, public data) and the pre-2026 namespace; a page
that is not the feed is a FAILURE, never an answer; the addresses are tried in
order and the first that parses wins; when none does, the fallback is served
MARKED STALE — never a guess; a rate outside the plausible range is refused.

What it cannot see: whether BNR moves the feed again (the fixture is a
recording — production's ``/api/fx-rates`` ``source`` field is the live
reading), and what the browser does with ``stale: true``.
Plant log: docs/engine_book/gates.md, "fx-feed".
"""

from __future__ import annotations

import re
import urllib.error
from pathlib import Path

import pytest

from engine.api import fx_rates

FIXTURE = Path(__file__).parent / "fixtures" / "fx" / "nbrfxrates_REAL_curs_bnr_ro.xml"
REAL = FIXTURE.read_bytes()

NEW = "https://curs.bnr.ro/nbrfxrates.xml"
OLD = "https://www.bnr.ro/nbrfxrates.xml"

#: What the old address answers once its redirect is followed (first bytes,
#: measured 2026-10-03): a 200 that is a web page.
HTML_PAGE = (b'<!doctype html><html lang="ro">\r\n<head>\r\n    <meta charset="UTF-8">\r\n'
             b"    <title>BNR Banca Nationala a Romaniei (BNR)</title></head><body></body></html>")


def _rate_in_file(currency: str) -> float:
    """The feed's own figure, read by a regex — not by the parser under test."""
    m = re.search(rb'<Rate currency="%s"(?: multiplier="(\d+)")?>([0-9.]+)</Rate>'
                  % currency.encode(), REAL)
    assert m, "the fixture carries no %s rate" % currency
    return float(m.group(2)) / (float(m.group(1)) if m.group(1) else 1.0)


class _Resp:
    def __init__(self, body: bytes, status: int = 200):
        self._body, self.status = body, status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _wire(monkeypatch, answers):
    """Replace the module's urlopen; return the list of addresses asked."""
    calls = []

    def urlopen(req, timeout=None):
        url = getattr(req, "full_url", str(req))
        calls.append(url)
        answer = answers[url]
        if isinstance(answer, Exception):
            raise answer
        return _Resp(answer)

    monkeypatch.setattr(fx_rates.urllib.request, "urlopen", urlopen)
    fx_rates.reset_fx_cache()
    return calls


@pytest.fixture(autouse=True)
def _clean_cache():
    fx_rates.reset_fx_cache()
    yield
    fx_rates.reset_fx_cache()


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


def test_a_multiplier_is_divided_out():
    quoted_per_100 = REAL.replace(b'<Rate currency="USD">4.7519</Rate>',
                                  b'<Rate currency="USD" multiplier="100">475.19</Rate>')
    assert quoted_per_100 != REAL
    assert fx_rates._parse_bnr_xml(quoted_per_100)["rates"]["USD"] == pytest.approx(
        5.3447 / 4.7519, rel=1e-9)


def test_a_web_page_is_not_the_feed():
    with pytest.raises(Exception):
        fx_rates._parse_bnr_xml(HTML_PAGE)


@pytest.mark.parametrize("planted", [
    b'<Rate currency="EUR">53.447</Rate>',     # ten times: a multiplier nobody divided
    b'<Rate currency="EUR">0.1871</Rate>',     # the pair inverted
])
def test_a_rate_outside_the_plausible_range_is_refused(planted):
    doc = REAL.replace(b'<Rate currency="EUR">5.3447</Rate>', planted)
    assert doc != REAL
    with pytest.raises(ValueError, match="plausible"):
        fx_rates._parse_bnr_xml(doc)


# ── the fetch: which address, in which order, and what a non-feed means ──


def test_the_feed_is_asked_at_the_address_it_lives_at_first():
    assert fx_rates._BNR_URLS[0] == NEW
    assert OLD in fx_rates._BNR_URLS


def test_the_live_rate_is_served_and_not_marked_stale(monkeypatch):
    calls = _wire(monkeypatch, {NEW: REAL, OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW], "the first address answered the feed; nothing else is asked"
    assert got["source"] == "BNR" and got["stale"] is False
    assert got["rates"]["RON"] == 5.3447 and got["as_of"] == "2026-10-02"


def test_production_as_it_was_the_old_address_alone_serves_the_fallback(monkeypatch):
    """The incident, reproduced: only the old address is known and it answers a
    web page. The answer must be the fallback MARKED STALE — and that is the
    whole of what production did for as long as the feed had moved."""
    monkeypatch.setattr(fx_rates, "_BNR_URLS", (OLD,))
    calls = _wire(monkeypatch, {OLD: HTML_PAGE})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [OLD]
    assert got["source"] == "fallback" and got["stale"] is True
    assert got["rates"] == fx_rates._FALLBACK_RATES


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
    assert got["source"] == "fallback" and got["stale"] is True
    assert got["as_of"] == fx_rates._FALLBACK_AS_OF
    # ...and inside the cooldown the answer costs no second fetch.
    again = fx_rates.get_fx_rates()
    assert calls == [NEW, OLD] and again["stale"] is True


def test_an_implausible_feed_is_never_served(monkeypatch):
    doc = REAL.replace(b'<Rate currency="EUR">5.3447</Rate>', b'<Rate currency="EUR">53.447</Rate>')
    calls = _wire(monkeypatch, {NEW: doc, OLD: doc})
    got = fx_rates.get_fx_rates(force_refresh=True)
    assert calls == [NEW, OLD]
    assert got["source"] == "fallback" and got["stale"] is True
    assert got["rates"]["RON"] == fx_rates._FALLBACK_RATES["RON"]
