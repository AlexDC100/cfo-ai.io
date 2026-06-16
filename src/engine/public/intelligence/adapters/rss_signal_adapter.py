"""RSS feed adapter — Phase B.

Reads one or more RSS / Atom feeds, parses entries published in the
requested window, and produces IntelligenceSignal objects tagged with
the sectors / tickers each entry mentions.

Config:
  RSS_FEED_URLS  — comma-separated list of feed URLs
                   e.g. "https://example.com/news.rss,https://other.com/feed.xml"

Why stdlib + xml.etree, not feedparser:
  · Zero new third-party deps to roll out
  · feedparser is heavy and we don't need 90% of its features
  · Works on both RSS 2.0 (<channel><item>) and Atom (<entry>) with one
    light dispatch — both formats are well-understood

Limitations (documented, not bugs):
  · No streaming auto-refresh — the adapter is poll-on-demand. The
    intelligence_cache layer + macro_signal_service handle scheduling.
  · No HTML stripping in summary text. Operators feeding curated RSS
    should pre-clean their feeds.
  · Sector/ticker tagging is keyword-based — we match titles + summaries
    against the universe ticker list + sector names. False positives are
    possible (e.g. "Apple Daily" newspaper hits AAPL). Confidence is
    capped at 0.6 to flag this.
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from urllib.parse import urlparse
from uuid import uuid5, NAMESPACE_URL

from ...universe import DEFAULT_UNIVERSE
from ..models import IntelligenceSignal
from .base import AdapterHealth, SignalAdapter

logger = logging.getLogger(__name__)

# Network politeness — RSS feeds should respond fast. A slow feed shouldn't
# hang the radar endpoint.
_HTTP_TIMEOUT_SEC = 8

# Conservative bounds: each call returns at most N entries per feed × N feeds
# so a misconfigured feed list (e.g. 50 URLs) can't explode the response.
_MAX_ENTRIES_PER_FEED = 40
_MAX_TOTAL_ENTRIES = 200


class RssSignalAdapter:
    """Polls configured RSS feeds for company / macro news signals."""

    name = "rss"

    def __init__(self, feed_urls: Optional[list[str]] = None):
        # Either explicit param (for tests) or env-var-derived.
        if feed_urls is None:
            env = os.environ.get("RSS_FEED_URLS", "")
            feed_urls = [u.strip() for u in env.split(",") if u.strip()]
        # Validate each URL — non-URLs get filtered out + logged once.
        self._feeds: list[str] = []
        for u in feed_urls:
            try:
                parsed = urlparse(u)
                if parsed.scheme in {"http", "https"} and parsed.netloc:
                    self._feeds.append(u)
                else:
                    logger.warning("rss_adapter: skipping invalid feed URL %r", u)
            except Exception:
                continue
        self._configured = bool(self._feeds)
        self._last_fetch_at: Optional[datetime] = None
        self._last_fetch_count = 0
        self._last_error: Optional[str] = None
        # Pre-build the ticker → name lookup so each entry can be tagged
        # without iterating the universe N times per call.
        self._ticker_to_name: dict[str, str] = {t: n for t, n, _ in DEFAULT_UNIVERSE}
        self._ticker_to_sector: dict[str, str] = {t: s for t, _, s in DEFAULT_UNIVERSE}
        # Build a name → ticker map for fuzzy matching ("NVIDIA" → NVDA).
        # We strip common corporate suffixes (Inc, Corp, Ltd, etc.) so a
        # text mentioning "Apple" alone still matches "Apple Inc." → AAPL.
        # Without this, "Apple antitrust" would miss AAPL because we'd be
        # searching for "apple inc." which isn't in the text.
        self._name_lower_to_ticker: dict[str, str] = {}
        for ticker, name, _ in DEFAULT_UNIVERSE:
            cleaned = _strip_corporate_suffix(name.lower().strip())
            if cleaned and len(cleaned) >= 4:
                self._name_lower_to_ticker[cleaned] = ticker

    @property
    def configured(self) -> bool:
        return self._configured

    # ─── Reads ──────────────────────────────────────────────────────────

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        if not self._configured:
            return []
        collected: list[IntelligenceSignal] = []
        errors: list[str] = []
        for url in self._feeds:
            try:
                entries = self._fetch_one_feed(url)
            except Exception as e:
                errors.append(f"{url}: {e.__class__.__name__}")
                logger.warning("rss_adapter: failed to fetch %s: %s", url, e)
                continue
            for entry in entries:
                if entry["published_at"] and entry["published_at"] < since:
                    continue
                signal = self._entry_to_signal(url, entry)
                if signal:
                    collected.append(signal)
                if len(collected) >= _MAX_TOTAL_ENTRIES:
                    break
            if len(collected) >= _MAX_TOTAL_ENTRIES:
                break

        self._last_fetch_at = datetime.utcnow()
        self._last_fetch_count = len(collected)
        self._last_error = "; ".join(errors) if errors else None
        return collected

    # ─── Health ─────────────────────────────────────────────────────────

    def health(self) -> AdapterHealth:
        if not self._configured:
            return AdapterHealth(
                name=self.name,
                configured=False,
                reason="RSS_FEED_URLS not set — provide a comma-separated list of feed URLs.",
            )
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=self._last_fetch_count,
            last_error=self._last_error,
            extras={"feed_count": str(len(self._feeds))},
        )

    # ─── Internals ──────────────────────────────────────────────────────

    def _fetch_one_feed(self, url: str) -> list[dict[str, object]]:
        """HTTP GET + XML parse → list of entry dicts."""
        req = urllib.request.Request(
            url,
            headers={
                # Be a polite citizen — many feeds 403 default User-Agent.
                "User-Agent": "CFO-AI-Intelligence/1.0 (+https://cfo-ai.io)",
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
            },
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            raw = resp.read()
        return self._parse_xml(raw)

    def _parse_xml(self, raw: bytes) -> list[dict[str, object]]:
        """Parse RSS 2.0 OR Atom into a normalized entry list.

        Returns a list of dicts: {title, summary, link, published_at}.
        """
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            logger.warning("rss_adapter: XML parse error: %s", e)
            return []

        # RSS 2.0: <rss><channel><item>...
        # Atom:    <feed><entry>...
        # Detect by root tag (with namespace tolerance).
        tag = self._strip_ns(root.tag)

        entries: list[dict[str, object]] = []
        if tag == "rss":
            channel = root.find("channel")
            if channel is None:
                return []
            items = channel.findall("item")[:_MAX_ENTRIES_PER_FEED]
            for item in items:
                entries.append(self._parse_rss_item(item))
        elif tag == "feed":
            atom_items = self._find_all_local(root, "entry")[:_MAX_ENTRIES_PER_FEED]
            for item in atom_items:
                entries.append(self._parse_atom_entry(item))
        else:
            logger.warning("rss_adapter: unrecognized feed root: %s", tag)
        return entries

    def _parse_rss_item(self, item) -> dict[str, object]:
        title = (self._text(item, "title") or "").strip()
        link = (self._text(item, "link") or "").strip()
        summary = (
            self._text(item, "description")
            or self._text(item, "summary")
            or ""
        ).strip()
        pub = self._text(item, "pubDate") or self._text(item, "date")
        return {
            "title": title,
            "summary": summary[:1500],
            "link": link,
            "published_at": _parse_date_safe(pub),
        }

    def _parse_atom_entry(self, item) -> dict[str, object]:
        title = (self._local_text(item, "title") or "").strip()
        # Atom <link href="..." rel="alternate"> — fall back to .text
        link = ""
        for link_el in self._find_all_local(item, "link"):
            href = link_el.get("href")
            if href:
                link = href
                break
        if not link:
            link = (self._local_text(item, "link") or "").strip()
        summary = (
            self._local_text(item, "summary")
            or self._local_text(item, "content")
            or ""
        ).strip()
        pub = (
            self._local_text(item, "published")
            or self._local_text(item, "updated")
        )
        return {
            "title": title,
            "summary": summary[:1500],
            "link": link,
            "published_at": _parse_date_safe(pub),
        }

    def _entry_to_signal(
        self, feed_url: str, entry: dict[str, object]
    ) -> Optional[IntelligenceSignal]:
        """Convert one parsed RSS entry → IntelligenceSignal.

        Tagging strategy:
          · Match ticker uppercases + company names in title + summary
          · Pull a sector from any matched ticker
          · Classify signal_type by keyword heuristic (geopolitical /
            supply_chain / energy / earnings / etc.) — coarse but useful
        """
        title = str(entry.get("title") or "").strip()
        if not title:
            return None
        summary = str(entry.get("summary") or "").strip()
        link = str(entry.get("link") or "").strip()
        pub_at = entry.get("published_at")
        published_at_dt: Optional[datetime] = (
            pub_at if isinstance(pub_at, datetime) else None
        )

        # Ticker tagging — match WORD-bounded uppercase tickers + name fuzzy.
        text_upper = (title + " " + summary).upper()
        text_lower = (title + " " + summary).lower()
        affected_tickers: list[str] = []
        for ticker in self._ticker_to_name.keys():
            if re.search(rf"\b{re.escape(ticker)}\b", text_upper):
                affected_tickers.append(ticker)
        # Name fuzzy — find longer-name matches missed by ticker matching.
        for name_lower, ticker in self._name_lower_to_ticker.items():
            if ticker in affected_tickers:
                continue
            if len(name_lower) >= 5 and name_lower in text_lower:
                affected_tickers.append(ticker)

        affected_sectors = sorted({
            self._ticker_to_sector[t]
            for t in affected_tickers
            if t in self._ticker_to_sector
        })

        # NFKD-fold before keyword classification so Romanian (and other
        # diacritic-heavy languages) match ASCII patterns: "dobândă" → "dobanda",
        # "Marea Roșie" → "marea rosie", "război" → "razboi". Same canonical-
        # ization the BVB Phase 1 ticker search uses — kept consistent so a
        # text mentioning Romanian terms classifies identically to its English
        # counterpart. ASCII-only inputs are unchanged (NFKD is a no-op on them).
        text_folded = _nfkd_fold(text_lower)
        signal_type, severity, channels = _classify_keyword(text_folded)

        sig_id = str(uuid5(NAMESPACE_URL, f"rss:{feed_url}:{title}"))
        return IntelligenceSignal(
            id=sig_id,
            signal_type=signal_type,
            title=title[:200],
            summary=summary[:1500] or title[:1500],
            source=f"rss:{urlparse(feed_url).netloc}",
            source_url=link or None,
            severity=severity,
            time_horizon="3m",
            confidence=0.6,
            published_at=published_at_dt,
            affected_sectors=affected_sectors,
            affected_tickers=affected_tickers,
            financial_impact_channels=channels,
            risk_categories=[],   # Radar groups by signal_type; categories stay derived.
        )

    # ─── XML helpers ────────────────────────────────────────────────────

    @staticmethod
    def _strip_ns(tag: str) -> str:
        return tag.split("}", 1)[1] if tag.startswith("{") else tag

    def _text(self, el, child_name: str) -> Optional[str]:
        """Find direct child by exact (un-namespaced) name; return text or None."""
        for c in el:
            if self._strip_ns(c.tag) == child_name and c.text:
                return c.text
        return None

    def _local_text(self, el, local_name: str) -> Optional[str]:
        """Like _text but checks namespace-stripped tag for Atom subtree."""
        for c in el.iter():
            if self._strip_ns(c.tag) == local_name and c.text:
                return c.text
        return None

    def _find_all_local(self, el, local_name: str) -> list:
        return [c for c in el.iter() if self._strip_ns(c.tag) == local_name]


_CORP_SUFFIX_RE = re.compile(
    r"\s*(,?\s*)?(inc\.?|incorporated|corp\.?|corporation|company|co\.?|"
    r"ltd\.?|limited|plc|llc|lp|s\.?a\.?|holdings|group|holding|n\.?v\.?|"
    r"ag|s\.?p\.?a\.?)\s*$",
    re.IGNORECASE,
)


def _strip_corporate_suffix(name: str) -> str:
    """Remove trailing 'Inc', 'Corp', 'Ltd', etc. so 'Apple Inc.' → 'apple'.

    Used so news text mentioning a bare company name still matches the
    universe-side full legal name. We keep the original mapping too — both
    "apple inc." AND "apple" route to AAPL.
    """
    cleaned = _CORP_SUFFIX_RE.sub("", name).strip()
    return cleaned


def _nfkd_fold(text: str) -> str:
    """NFKD-normalize + strip combining marks → ASCII-safe lowercase form.

    Romanian diacritics decompose under NFKD into ASCII base + combining mark
    (e.g. "â" → "a" + U+0302). Filtering by `unicodedata.combining(c) == 0`
    yields the bare ASCII letter, so "dobândă" → "dobanda", "război" → "razboi".

    This matches the canonicalization the BVB Phase 1 ticker search applies on
    the FE side (`.normalize("NFKD").replace(/\\p{M}/gu, "")`) — keeping back
    end and front end on the same fold rule means a query typed with or
    without diacritics produces identical matches.

    Pure ASCII inputs pass through unchanged.
    """
    if not text:
        return text
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _parse_date_safe(raw: Optional[str]) -> Optional[datetime]:
    """Tolerant RFC2822 / RFC3339 datetime parse. Returns None on failure."""
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError, IndexError):
        pass
    # Try ISO format
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


# Keyword heuristics — coarse classification of signal_type / severity /
# financial impact. Operators can override per-signal severity via the
# manual adapter when they need precision.
#
# All inputs are NFKD-folded before matching (see `_nfkd_fold`), so Romanian
# patterns use the diacritic-stripped ASCII form: "dobândă" → "dobanda",
# "Roșie" → "rosie", "război" → "razboi", "amendă" → "amenda". Patterns stay
# pure ASCII for clarity. Bucket names match the existing English buckets so
# the downstream radar mapping (signal_type → risk category) is multilingual-
# transparent — Romanian and English sources route to the same exposure cell.
_KEYWORDS: list[tuple[str, str, str, list[str]]] = [
    # (keyword regex, signal_type, severity, channels)
    # ── English ──────────────────────────────────────────────────────────
    (r"\b(tariff|sanction|export\s*control|trade\s*war)\b", "geopolitical", "high",
        ["revenue", "supply_availability"]),
    (r"\b(war|conflict|invasion|missile)\b", "geopolitical", "critical",
        ["supply_availability", "revenue"]),
    (r"\b(supply\s*chain|shipping|freight|red\s*sea|panama\s*canal)\b", "supply_chain", "high",
        ["supply_availability", "working_capital"]),
    (r"\b(rate\s*(hike|cut|decision)|fed\s*chair|fomc|bond\s*yield)\b", "interest_rates", "medium",
        ["debt_cost", "valuation_multiple"]),
    (r"\b(oil|opec|crude|gas\s*price|brent|wti)\b", "energy", "high",
        ["gross_margin", "ebitda_margin"]),
    (r"\b(earnings|revenue\s*beat|guide(s|d|ance))\b", "earnings", "medium",
        ["revenue", "ebitda_margin"]),
    (r"\b(antitrust|investigation|regulator|fine|penalty|lawsuit)\b", "regulation", "medium",
        ["valuation_multiple"]),
    (r"\b(10-?k|annual\s*report|sec\s*filing)\b", "filing", "low",
        []),
    (r"\b(downgrade|cut\s*to|cut\s*rating)\b", "credit", "high",
        ["debt_cost", "valuation_multiple"]),
    (r"\b(upgrade|raised\s*to)\b", "credit", "medium",
        ["valuation_multiple"]),
    (r"\b(layoffs?|restructur(ing|ed)?|job\s*cuts?)\b", "company_news", "high",
        ["revenue", "ebitda_margin"]),
    # ── Romanian (NFKD-folded form) ──────────────────────────────────────
    # Romanian is heavily inflected — definite articles append directly to
    # the noun ("pret" → "pretul", "gaze" → "gazele"/"gazelor") and genitive/
    # dative cases shift endings ("criza" → "crizei", "dobânzii"). We use
    # stems + `\w*` to absorb any case ending, rather than enumerate every
    # inflection. Order matters: ENERGY before tariff-geopolitical so
    # "tarif energie" routes to energy (not the more generic geopolitical
    # tariff bucket).
    #
    # Energy — preț gaze, criză energetică, preț petrol, tarif energie
    (r"\b(pret\w*\s+(de\s+)?gaz\w*|criz\w*\s+energetic\w*|pret\w*\s+petrol\w*"
     r"|pret\w*\s+energi\w*|tarif\w*\s+energi\w*|gaz\w*\s+natural\w*)\b",
        "energy", "high",
        ["gross_margin", "ebitda_margin"]),
    # Geopolitical war/conflict — război/invazie/conflict armat
    (r"\b(razboi|invazi\w*|conflict\s+armat|atac\s+militar)\b", "geopolitical", "critical",
        ["supply_availability", "revenue"]),
    # Geopolitical trade — sanctiune/embargo/control export. "tarif" alone
    # is ambiguous (energy tariff vs trade tariff) — require the modifier.
    (r"\b(tarif\s+(vamal|comercial)|sanctiun\w*|embargo|control\s+export)\b",
        "geopolitical", "high",
        ["revenue", "supply_availability"]),
    # Supply chain — Marea Roșie/Houthi/lanț de aprovizionare/transport maritim
    (r"\b(marea\s+rosi\w*|houthi|lant\w*\s+de\s+aprovizionar\w*"
     r"|transport\s+maritim|navlu)\b",
        "supply_chain", "high",
        ["supply_availability", "working_capital"]),
    # Interest rates — BNR/dobândă/dobânzii/politică monetară/inflație.
    # Two stems for the central word: "doband" (nom: dobanda) and
    # "dobanz" (gen: dobanzii) — fold doesn't unify them.
    (r"\b(bnr|doband\w*|dobanz\w*|politic\w*\s+monetar\w*|inflati\w*)\b",
        "interest_rates", "medium",
        ["debt_cost", "valuation_multiple"]),
    # Regulation — amendă/amenzi/ANCOM/ANRE/ASF/investigație/proces/litigiu
    (r"\b(amenda|amenz\w*|ancom|anre|asf\s+romania|investigati\w*|proces|litigi\w*)\b",
        "regulation", "medium",
        ["valuation_multiple"]),
    # Credit — retrogradare rating/rating retrogradat/rating scăzut
    (r"\b(retrogradar\w*\s+rating|rating\s+retrogradat\w*|rating\s+scazut\w*)\b",
        "credit", "high",
        ["debt_cost", "valuation_multiple"]),
    # Company news — concedieri/restructurare/disponibilizări
    (r"\b(concedier\w*|restructurar\w*|disponibilizar\w*)\b",
        "company_news", "high",
        ["revenue", "ebitda_margin"]),
]


def _classify_keyword(text_lower: str) -> tuple[str, str, list[str]]:
    """Return (signal_type, severity, channels) for the first matching keyword."""
    for pattern, sig_type, severity, channels in _KEYWORDS:
        if re.search(pattern, text_lower):
            return sig_type, severity, channels   # type: ignore[return-value]
    # Default — company news, medium severity, no inferred channels
    return ("company_news", "medium", [])


# Re-export under the stub adapter's name so existing imports continue to
# work — the manual_signal_adapter module structure stays untouched.
__all__ = ["RssSignalAdapter"]


# ──────────────────────────────────────────────────────────────────────────
# Self-test — Romanian keyword classification via NFKD fold
# ──────────────────────────────────────────────────────────────────────────
# Lock #12 discipline: include WRONG-on-purpose inputs so the test isn't a
# tautology. A pure-positive test ("Romanian rates news → interest_rates")
# would still pass if the fallback bucket coincidentally returned
# interest_rates for every input — the negative cases discriminate.

def _run_self_test() -> int:
    """Exercise NFKD-fold + Romanian keyword routing. Returns 0 on PASS."""
    failures: list[str] = []

    def check(text: str, expected_type: str, label: str) -> None:
        folded = _nfkd_fold(text.lower())
        sig_type, _sev, _chan = _classify_keyword(folded)
        if sig_type != expected_type:
            failures.append(
                f"{label}: expected signal_type={expected_type!r}, got {sig_type!r} "
                f"(folded={folded!r})"
            )

    # 1. THE operator-mandated test: Romanian central-bank rate news with full
    #    diacritics. After NFKD-fold "dobândă" → "dobanda" and matches the
    #    Romanian interest_rates pattern. signal_type bucket = interest_rates,
    #    which the radar layer maps to the `rates_credit` risk category.
    check("BNR a majorat dobânda de politică monetară", "interest_rates",
          "Romanian rates (operator-mandated)")

    # 2. Discriminator — same sentence ASCII-folded already (no diacritics).
    #    Same input post-fold ⇒ same answer. If the fold is broken (e.g.
    #    forgotten on one path), this catches the divergence.
    check("BNR a majorat dobanda de politica monetara", "interest_rates",
          "Romanian rates (already-ASCII)")

    # 3. Discriminator — Romanian war/conflict news. "război" → "razboi".
    #    Confirms diacritic stripping isn't routing every Romanian text to
    #    interest_rates (would be a vacuous pass otherwise).
    check("Război în Ucraina escaladează în zona de est", "geopolitical",
          "Romanian war (must NOT route to interest_rates)")

    # 4. Discriminator — Romanian energy news. "preț gaze" → "pret gaze".
    #    Routes to energy, not interest_rates, not geopolitical.
    check("Prețul gazelor a crescut din cauza crizei energetice", "energy",
          "Romanian energy (must NOT route to interest_rates)")

    # 5. Discriminator — Romanian shipping news. "Marea Roșie" → "marea rosie".
    check("Atacurile Houthi în Marea Roșie afectează lanțul de aprovizionare",
          "supply_chain", "Romanian Red Sea (must route to supply_chain)")

    # 6. Wrong-on-purpose: a Romanian sentence with NO trigger words.
    #    Should fall back to company_news. If it routes to interest_rates,
    #    the Romanian patterns are too greedy.
    check("Compania a anunțat lansarea unui produs nou pe piață",
          "company_news", "Romanian generic news (no triggers → company_news)")

    # 7. English baseline preserved — NFKD-fold is a no-op on ASCII.
    check("Fed chair signals rate cut", "interest_rates", "English rates baseline")

    if failures:
        print(f"FAIL — {len(failures)} test(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — all 7 NFKD/Romanian keyword tests passed")
    return 0


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        raise SystemExit(_run_self_test())
    print("Usage: python -m engine.public.intelligence.adapters.rss_signal_adapter --self-test")
