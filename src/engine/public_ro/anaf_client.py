"""Polite ANAF v9 adapter — secondary, per-CUI, CURRENT-STATE only.

Endpoint (documented, public, no auth):
    POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
    body: JSON array of {"cui": <int>, "data": "YYYY-MM-DD"}

Published limits (verbatim, from
https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt):
    "Un request poate contine maxim 100 de CUI-uri. Un client poate
    executa maxim 1 request pe secunda"
    "Orice tentativa de suprasolicitare a serverului va fi pedepsita
    conform reglementarilor in vigoare"

Those terms are HARD-ENFORCED here: batches never exceed 100 CUIs and
requests are spaced >= 1s on a monotonic clock (injectable for tests),
with exponential backoff on 5xx. The response's date_generale carries
denumire/adresa/nrRegCom/cod_CAEN/forma_organizare etc. — current
state only; NEVER use it to reconstruct historical names/forms.

NEVER called by page serving — operator/cron refresh only. Updates are
gated on the store's existing tip_contrib=='PJ' (PS7 belt-and-braces:
an ANAF-derived record cannot make a PF-marked or unknown CUI
publishable, and F-series register numbers stay unpublishable).
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Sequence

from .store import PublicRoStore

ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva"
MAX_CUIS_PER_REQUEST = 100
MIN_INTERVAL_SECONDS = 1.0

SOURCE_TERMS = (
    "ANAF WS v9: max 100 CUIs/request, max 1 request/second; "
    '"Orice tentativa de suprasolicitare a serverului va fi pedepsita '
    'conform reglementarilor in vigoare" (doc_WS_V9.txt).'
)


class AnafError(RuntimeError):
    pass


def _default_post(url: str, body: bytes, timeout: int = 60) -> bytes:
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "cfo-ai.io public-data spine (contact: cfo-ai.io)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read()


class AnafClient:
    """Batching + hard rate-limit + backoff. ``post``, ``clock`` and
    ``sleeper`` are injectable so tests exercise the politeness
    contract with a fake clock and zero network."""

    def __init__(
        self,
        *,
        post: Optional[Callable[[str, bytes], bytes]] = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        min_interval: float = MIN_INTERVAL_SECONDS,
        max_retries: int = 3,
        backoff_base: float = 2.0,
    ) -> None:
        self._post = post or _default_post
        self._clock = clock
        self._sleep = sleeper
        self._min_interval = float(min_interval)
        self._max_retries = int(max_retries)
        self._backoff_base = float(backoff_base)
        self._last_request_at: Optional[float] = None
        self.request_times: List[float] = []  # observability for tests

    def _wait_politely(self) -> None:
        if self._last_request_at is not None:
            elapsed = self._clock() - self._last_request_at
            remaining = self._min_interval - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _one_request(self, batch: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        body = json.dumps(list(batch)).encode("utf-8")
        last_exc: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            self._wait_politely()
            self._last_request_at = self._clock()
            self.request_times.append(self._last_request_at)
            try:
                raw = self._post(ANAF_URL, body)
                doc = json.loads(raw.decode("utf-8"))
                if not isinstance(doc, dict):
                    raise AnafError("unexpected response shape")
                return doc
            except urllib.error.HTTPError as exc:
                last_exc = exc
                if exc.code < 500 or attempt >= self._max_retries:
                    raise AnafError("ANAF HTTP %d" % exc.code) from exc
                self._sleep(self._backoff_base * (2**attempt))
            except (urllib.error.URLError, ValueError) as exc:
                last_exc = exc
                if attempt >= self._max_retries:
                    raise AnafError(
                        "ANAF request failed: %s" % exc
                    ) from exc
                self._sleep(self._backoff_base * (2**attempt))
        raise AnafError("ANAF request failed: %s" % last_exc)

    def lookup(
        self, cuis: Sequence[int], *, date: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Query up to N CUIs (auto-batched at 100/request, >=1s apart).
        Returns the concatenated ``found`` records."""
        the_date = date or time.strftime("%Y-%m-%d", time.gmtime())
        found: List[Dict[str, Any]] = []
        cui_list = [int(c) for c in cuis]
        for start in range(0, len(cui_list), MAX_CUIS_PER_REQUEST):
            batch = [
                {"cui": c, "data": the_date}
                for c in cui_list[start : start + MAX_CUIS_PER_REQUEST]
            ]
            doc = self._one_request(batch)
            found.extend(doc.get("found") or [])
        return found


def refresh_company(
    store: PublicRoStore,
    cuis: Sequence[int],
    *,
    client: Optional[AnafClient] = None,
    date: Optional[str] = None,
) -> Dict[str, int]:
    """Refresh name/caen/reg for CUIs the store ALREADY knows as PJ.
    Non-PJ / unknown CUIs are skipped before any network call (PS7)."""
    client = client or AnafClient()
    pj_cuis = []
    for cui in cuis:
        company = store.get_company(int(cui))
        if company is not None and company.get("tip_contrib") == "PJ":
            pj_cuis.append(int(cui))
    counts = {"requested": len(pj_cuis), "updated": 0, "skipped_non_pj":
              len(cuis) - len(pj_cuis)}
    if not pj_cuis:
        return counts
    for record in client.lookup(pj_cuis, date=date):
        general = record.get("date_generale") or {}
        cui = general.get("cui")
        if cui is None:
            continue
        company = store.get_company(int(cui))
        if company is None or company.get("tip_contrib") != "PJ":
            continue
        reg = (general.get("nrRegCom") or "").strip() or None
        publishable = company.get("publishable", False)
        if reg and reg[:1].upper() == "F":
            publishable = False  # PFA/II/IF register — never publishable
        store.set_identification(
            int(cui),
            name=(general.get("denumire") or "").strip() or company.get("name"),
            county=company.get("county"),
            locality=company.get("locality"),
            reg_number=reg or company.get("reg_number"),
            tip_contrib="PJ",
            publishable=bool(publishable),
            name_source="anaf_v9",
        )
        caen = general.get("cod_CAEN")
        if caen not in (None, ""):
            store.ensure_company_stub(int(cui), str(caen))
        counts["updated"] += 1
    return counts
