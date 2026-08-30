# -*- coding: utf-8 -*-
"""SQLite layer for the public_market spine — ``data/public_market.db``.

House idiom, borrowed from ``engine.public_ro.store`` and deliberately
NOT imported from it (a shared base class would couple two document
classes that must be able to diverge): stdlib ``sqlite3`` only, one
connection per store instance, ``PRAGMA journal_mode=WAL`` +
``busy_timeout`` so a serving request reads while an ingest writes, and
a process lock serializing this process's writes.

A SEPARATE database file from ``engine.db`` and from ``public_ro.db``:
public_market is a sibling document class with its own lifecycle, its own
retention, and its own takedown surface. One file per class means a
restore, a purge, or a schema migration on one never touches the others.

THE ADAPTER CONTRACT (already coded against by ``edgar._discover_store``)
------------------------------------------------------------------------
    get_store()            -> PublicMarketStore
    store.put(envelope)    -> str (entity_id)      # best-effort cache write
    store.get(cik)         -> Optional[dict]       # envelope by CIK

``put`` accepts BOTH a raw adapter envelope and a normalized pm1 one. A
raw envelope is normalized here (``model.normalize_envelope``) using the
market resolved from the registry's REVERSE source lookup — never from a
market-id branch in this module. When the source maps to more than one
market (filings.xbrl.org feeds four), the caller must pass ``market_id``
explicitly; ``put`` refuses rather than picking one.

LAWS THIS FILE KEEPS
--------------------
* **ABSENT != ZERO.** A figure that was never fetched is a missing row,
  never a 0. No column defaults to 0 for a fact.
* **Every stored figure keeps its provenance.** The ``provenance`` table
  is written from the envelope's own per-figure blocks; nothing here
  invents a source, an as_of, or a version.
* **Nothing is overwritten silently.** Filings are keyed by
  (entity_id, accession_or_version); re-ingesting the same filing is an
  idempotent replace of identical content, and a CHANGED content hash
  for the same accession is recorded in ``review_queue`` rather than
  quietly swapping the numbers under a served page.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from engine.public_market import model as _model
from engine.public_market import registry as _registry

DB_ENV = "PUBLIC_MARKET_DB_PATH"
SCHEMA_VERSION = 1


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_db_path() -> Path:
    env = os.environ.get(DB_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "public_market.db"


_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    # One canonical company. entity_id is the entity lane's deterministic
    # mint (stable across machines), so two stores built independently
    # agree on ids and re-ingest is idempotent.
    """CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        market_id TEXT,
        ticker TEXT,
        name TEXT,
        cik TEXT,
        isin TEXT,
        lei TEXT,
        currency TEXT,
        source TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_entities_market ON entities(market_id)",
    "CREATE INDEX IF NOT EXISTS idx_entities_ticker ON entities(market_id, ticker)",
    "CREATE INDEX IF NOT EXISTS idx_entities_cik ON entities(cik)",
    # One filing == one pm1 envelope, stored verbatim. The envelope is
    # the record; the columns beside it are indexes into it, never a
    # second (drift-prone) copy of the truth.
    """CREATE TABLE IF NOT EXISTS filings (
        entity_id TEXT NOT NULL,
        accession_or_version TEXT NOT NULL,
        market_id TEXT,
        source TEXT,
        as_of TEXT,
        fiscal_year INTEGER,
        period_end TEXT,
        fetched_at TEXT,
        content_hash TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, accession_or_version)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_filings_entity_asof "
    "ON filings(entity_id, as_of)",
    "CREATE INDEX IF NOT EXISTS idx_filings_market ON filings(market_id)",
    # Prices are OPTIONAL by design (keyless mode stores none). A missing
    # row means "no licensed price", never "the price was zero".
    """CREATE TABLE IF NOT EXISTS prices (
        entity_id TEXT NOT NULL,
        as_of TEXT NOT NULL,
        market_id TEXT,
        price_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        minor_unit TEXT,
        delay_note TEXT,
        cadence TEXT,
        stale INTEGER,
        source TEXT,
        fetched_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, as_of)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_prices_entity ON prices(entity_id, as_of)",
    # Per-figure provenance, flattened out of the envelope so an auditor
    # can ask "which accession backs this number?" without parsing JSON.
    """CREATE TABLE IF NOT EXISTS provenance (
        entity_id TEXT NOT NULL,
        accession_or_version TEXT NOT NULL,
        figure TEXT NOT NULL,
        source TEXT,
        as_of TEXT,
        fetched_at TEXT,
        PRIMARY KEY (entity_id, accession_or_version, figure)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_provenance_entity ON provenance(entity_id)",
    # Everything that must not be auto-resolved: unmintable records,
    # conflicting content under one accession, envelopes that failed pm1
    # validation. Append-only; a human decides.
    """CREATE TABLE IF NOT EXISTS review_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        market_id TEXT,
        entity_id TEXT,
        source TEXT,
        source_entity_id TEXT,
        reason TEXT NOT NULL,
        detail TEXT,
        payload_json TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_review_created ON review_queue(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_review_reason ON review_queue(reason)",
]

#: review_queue reasons this module writes. Stable strings — the review
#: surface groups on them.
REASON_NO_DETERMINISTIC_KEY = "no_deterministic_key"
REASON_AMBIGUOUS_MARKET = "ambiguous_market_for_source"
REASON_INVALID_ENVELOPE = "invalid_pm1_envelope"
REASON_CONTENT_CHANGED = "accession_content_changed"


class StoreError(RuntimeError):
    """A write that cannot proceed without guessing."""


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


class PublicMarketStore:
    """One connection per store instance; a lock serializes writes from
    this process (WAL + busy_timeout handle cross-process)."""

    def __init__(self, path: Optional[Any] = None) -> None:
        self.path = Path(path) if path else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._lock = threading.Lock()
        self._ensure_schema()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "PublicMarketStore":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # ── schema ─────────────────────────────────────────────────────

    def _ensure_schema(self) -> None:
        with self._lock, self._conn:
            for stmt in _SCHEMA:
                self._conn.execute(stmt)
            self._conn.execute(
                "INSERT OR IGNORE INTO schema_meta(key, value) VALUES "
                "('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )

    def schema_version(self) -> int:
        row = self._conn.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        return int(row["value"]) if row else 0

    # ── review queue ───────────────────────────────────────────────

    def queue_review(self, reason: str, *, detail: Optional[str] = None,
                     market_id: Optional[str] = None,
                     entity_id: Optional[str] = None,
                     source: Optional[str] = None,
                     source_entity_id: Optional[str] = None,
                     payload: Optional[Any] = None) -> int:
        """Append one review entry. Append-only: entries are never
        rewritten, so the queue doubles as the audit trail for every
        refusal the spine made."""
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "INSERT INTO review_queue(created_at, market_id, entity_id, "
                "source, source_entity_id, reason, detail, payload_json) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (_now_iso(), market_id, entity_id, source, source_entity_id,
                 reason, detail, _json(payload) if payload is not None else None),
            )
            return int(cursor.lastrowid)

    def review_queue(self, limit: int = 100,
                     reason: Optional[str] = None) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        if reason:
            rows = self._conn.execute(
                "SELECT * FROM review_queue WHERE reason=? "
                "ORDER BY id DESC LIMIT ?", (reason, limit)
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM review_queue ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            if item.get("payload_json"):
                try:
                    item["payload"] = json.loads(item["payload_json"])
                except ValueError:  # pragma: no cover — we wrote it
                    item["payload"] = None
            else:
                item["payload"] = None
            out.append(item)
        return out

    # ── entities ───────────────────────────────────────────────────

    def upsert_entity(self, entity_id: str, *, market_id: Optional[str],
                      ticker: Optional[str] = None, name: Optional[str] = None,
                      cik: Optional[str] = None, isin: Optional[str] = None,
                      lei: Optional[str] = None, currency: Optional[str] = None,
                      source: Optional[str] = None) -> None:
        """Create or refresh one entity row.

        COALESCE on every optional column: a later source that knows less
        than an earlier one must never blank a known identifier. Absence
        in the incoming record is "no opinion", not "cleared"."""
        now = _now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO entities(entity_id, market_id, ticker, name, cik, "
                "isin, lei, currency, source, first_seen_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(entity_id) DO UPDATE SET "
                "market_id=COALESCE(excluded.market_id, entities.market_id), "
                "ticker=COALESCE(excluded.ticker, entities.ticker), "
                "name=COALESCE(excluded.name, entities.name), "
                "cik=COALESCE(excluded.cik, entities.cik), "
                "isin=COALESCE(excluded.isin, entities.isin), "
                "lei=COALESCE(excluded.lei, entities.lei), "
                "currency=COALESCE(excluded.currency, entities.currency), "
                "source=COALESCE(excluded.source, entities.source), "
                "updated_at=excluded.updated_at",
                (entity_id, market_id, ticker, name, cik, isin, lei,
                 currency, source, now, now),
            )

    def get_entity(self, entity_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM entities WHERE entity_id=?", (entity_id,)
        ).fetchone()
        return dict(row) if row else None

    def find_entity_by_ticker(self, market_id: str,
                              ticker: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM entities WHERE market_id=? AND ticker=? "
            "COLLATE NOCASE", (market_id, (ticker or "").strip().upper())
        ).fetchone()
        return dict(row) if row else None

    def find_entity_by_cik(self, cik: Any) -> Optional[Dict[str, Any]]:
        """CIK lookup, tolerant of zero-padding: the SEC writes
        ``320193`` in one file and ``0000320193`` in another, and a store
        that answers only one of them looks empty for the other."""
        key = str(cik or "").strip()
        if not key:
            return None
        candidates = [key]
        digits = key.lstrip("0")
        if digits.isdigit():
            candidates.append(digits.zfill(10))
            candidates.append(digits)
        placeholders = ",".join("?" for _ in candidates)
        row = self._conn.execute(
            "SELECT * FROM entities WHERE cik IN (%s) LIMIT 1" % placeholders,
            candidates,
        ).fetchone()
        return dict(row) if row else None

    def entity_count(self, market_id: Optional[str] = None) -> int:
        if market_id:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM entities WHERE market_id=?",
                (market_id,)
            ).fetchone()
        else:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM entities").fetchone()
        return int(row["n"])

    def market_counts(self) -> Dict[str, int]:
        """entity count per market — the registry surface's honest
        'how much do we actually hold?' column."""
        rows = self._conn.execute(
            "SELECT market_id, COUNT(*) AS n FROM entities "
            "WHERE market_id IS NOT NULL GROUP BY market_id"
        ).fetchall()
        return dict((str(r["market_id"]), int(r["n"])) for r in rows)

    # ── filings (pm1 envelopes) ────────────────────────────────────

    def put_filing(self, envelope: Dict[str, Any]) -> str:
        """Persist ONE validated pm1 envelope plus its per-figure
        provenance. Returns the entity_id.

        Refuses (StoreError) an envelope that fails pm1 validation, after
        recording the violations in the review queue — a document we
        cannot describe must not become a document we serve."""
        problems = _model.validate_envelope(envelope)
        if problems:
            self.queue_review(
                REASON_INVALID_ENVELOPE,
                detail="; ".join(problems[:10]),
                market_id=envelope.get("market_id") if isinstance(envelope, dict) else None,
                entity_id=envelope.get("entity_id") if isinstance(envelope, dict) else None,
                payload={"problems": problems},
            )
            raise StoreError("envelope fails pm1 validation: %s" % "; ".join(problems[:5]))

        entity_id = str(envelope["entity_id"])
        market_id = str(envelope["market_id"])
        provenance = envelope.get("provenance") or {}
        accession = _model.derive_accession_or_version(provenance) \
            if isinstance(provenance, dict) else None
        if not accession:
            # No dataset version to key on. Store under the content hash
            # so the row is still addressable and still honest about what
            # it is — never under a made-up accession.
            accession = str(envelope["content_hash"])
        anchor = envelope.get("fiscal_anchor") or {}
        fiscal_year = anchor.get("latest_fy") if isinstance(anchor, dict) else None
        period_end = anchor.get("latest_annual_end") if isinstance(anchor, dict) else None
        market = envelope.get("market") or {}
        entity = envelope.get("entity") or {}

        existing = self._conn.execute(
            "SELECT content_hash FROM filings WHERE entity_id=? AND "
            "accession_or_version=?", (entity_id, accession)
        ).fetchone()
        if existing is not None and existing["content_hash"] != envelope["content_hash"]:
            # Same source version, different bytes. That is either a
            # restatement or a bug; either way a human decides, and the
            # served page keeps the numbers it already had.
            self.queue_review(
                REASON_CONTENT_CHANGED,
                detail="accession %s changed content hash %s -> %s"
                       % (accession, existing["content_hash"], envelope["content_hash"]),
                market_id=market_id,
                entity_id=entity_id,
                source=str(provenance.get("source") or "") or None,
                payload={"accession_or_version": accession},
            )
            raise StoreError(
                "accession %s already stored with a different content hash — "
                "queued for review rather than overwritten" % accession
            )

        self.upsert_entity(
            entity_id,
            market_id=market_id,
            ticker=entity.get("ticker"),
            name=entity.get("name"),
            cik=entity.get("cik"),
            isin=entity.get("isin"),
            lei=entity.get("lei"),
            currency=market.get("currency"),
            source=str(provenance.get("source") or "") or None,
        )

        now = _now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO filings(entity_id, accession_or_version, market_id, "
                "source, as_of, fiscal_year, period_end, fetched_at, "
                "content_hash, envelope_json, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(entity_id, accession_or_version) DO UPDATE SET "
                "market_id=excluded.market_id, source=excluded.source, "
                "as_of=excluded.as_of, fiscal_year=excluded.fiscal_year, "
                "period_end=excluded.period_end, fetched_at=excluded.fetched_at, "
                "content_hash=excluded.content_hash, "
                "envelope_json=excluded.envelope_json, "
                "updated_at=excluded.updated_at",
                (entity_id, accession, market_id,
                 str(provenance.get("source") or "") or None,
                 provenance.get("as_of"), fiscal_year, period_end,
                 provenance.get("fetched_at"), envelope["content_hash"],
                 _json(envelope), now),
            )
            for name in sorted(envelope.get("figures") or {}):
                view = _model.figure_provenance(envelope, name)
                if not view:
                    continue
                self._conn.execute(
                    "INSERT INTO provenance(entity_id, accession_or_version, "
                    "figure, source, as_of, fetched_at) VALUES (?,?,?,?,?,?) "
                    "ON CONFLICT(entity_id, accession_or_version, figure) "
                    "DO UPDATE SET source=excluded.source, as_of=excluded.as_of, "
                    "fetched_at=excluded.fetched_at",
                    (entity_id,
                     str(view.get("accession_or_version") or accession),
                     name, view.get("source"), view.get("as_of"),
                     view.get("fetched_at")),
                )
        return entity_id

    def get_filing(self, entity_id: str,
                   accession_or_version: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT envelope_json FROM filings WHERE entity_id=? AND "
            "accession_or_version=?", (entity_id, accession_or_version)
        ).fetchone()
        return json.loads(row["envelope_json"]) if row else None

    def latest_filing(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """The freshest stored envelope for one entity.

        Ordered by ``as_of`` then ``updated_at`` — never by rowid alone:
        re-ingesting an OLD filing after a new one must not make the old
        one 'latest'."""
        row = self._conn.execute(
            "SELECT envelope_json FROM filings WHERE entity_id=? "
            "ORDER BY COALESCE(as_of,'') DESC, updated_at DESC LIMIT 1",
            (entity_id,)
        ).fetchone()
        return json.loads(row["envelope_json"]) if row else None

    def filings_for(self, entity_id: str,
                    limit: int = 20) -> List[Dict[str, Any]]:
        """Filing INDEX rows (not envelopes) for one entity, newest first."""
        limit = max(1, min(int(limit), 500))
        rows = self._conn.execute(
            "SELECT entity_id, accession_or_version, market_id, source, as_of, "
            "fiscal_year, period_end, fetched_at, content_hash, updated_at "
            "FROM filings WHERE entity_id=? "
            "ORDER BY COALESCE(as_of,'') DESC, updated_at DESC LIMIT ?",
            (entity_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]

    def provenance_for(self, entity_id: str) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM provenance WHERE entity_id=? ORDER BY figure",
            (entity_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── prices ─────────────────────────────────────────────────────

    def put_price(self, entity_id: str, price: Dict[str, Any], *,
                  market_id: Optional[str] = None) -> None:
        """Persist ONE labeled price block.

        Requires integer ``price_minor``, a currency and an ``as_of``: an
        undated or float price is exactly the freshness/rounding lie the
        prices lane refuses to serve, so it is refused here too rather
        than coerced into a column."""
        if not isinstance(price, dict):
            raise StoreError("price must be a dict")
        as_of = price.get("as_of")
        currency = price.get("currency")
        minor = price.get("price_minor")
        if not isinstance(as_of, str) or not as_of:
            raise StoreError("price has no as_of — refusing to store an undated quote")
        if not isinstance(currency, str) or not currency:
            raise StoreError("price has no currency")
        if isinstance(minor, bool) or not isinstance(minor, int):
            raise StoreError(
                "price_minor must be an integer in minor units (got %r) — "
                "a float price is a rounding bug, not a price" % (minor,)
            )
        stale = price.get("stale")
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO prices(entity_id, as_of, market_id, price_minor, "
                "currency, minor_unit, delay_note, cadence, stale, source, "
                "fetched_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(entity_id, as_of) DO UPDATE SET "
                "market_id=excluded.market_id, price_minor=excluded.price_minor, "
                "currency=excluded.currency, minor_unit=excluded.minor_unit, "
                "delay_note=excluded.delay_note, cadence=excluded.cadence, "
                "stale=excluded.stale, source=excluded.source, "
                "fetched_at=excluded.fetched_at, updated_at=excluded.updated_at",
                (entity_id, as_of, market_id or price.get("market"),
                 minor, currency, price.get("minor_unit"),
                 price.get("delay_note"), price.get("cadence"),
                 None if stale is None else (1 if stale else 0),
                 price.get("source"), price.get("fetched_at"), _now_iso()),
            )

    def latest_price(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """The freshest stored price, or None. None is ABSENCE (keyless
        mode / no licence), never a zero quote."""
        row = self._conn.execute(
            "SELECT * FROM prices WHERE entity_id=? ORDER BY as_of DESC LIMIT 1",
            (entity_id,)
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        if out.get("stale") is not None:
            out["stale"] = bool(out["stale"])
        return out

    # ── the adapter-facing contract ────────────────────────────────

    def put(self, envelope: Dict[str, Any],
            market_id: Optional[Any] = None) -> str:
        """The documented adapter entry point: cache one envelope.

        Accepts a RAW adapter envelope or an already-normalized pm1 one.
        A raw envelope is normalized here, with the market resolved from
        the registry's reverse ``fundamentals_source`` lookup — there is
        no market-id branch in this module. An ambiguous source (one feed
        serving several markets) is queued for review and refused, not
        assigned to whichever market happens to be first.
        """
        if not isinstance(envelope, dict):
            raise StoreError("put() needs a dict envelope")
        if envelope.get("version") == _model.PUBLIC_MARKET_VERSION \
                and envelope.get("content_hash"):
            return self.put_filing(envelope)

        if not _model.is_public_market_envelope(envelope):
            raise StoreError(
                "refusing a document that is not a public_market envelope "
                "(doc_class/status/figures)"
            )
        provenance = envelope.get("provenance") or {}
        source = provenance.get("source") if isinstance(provenance, dict) else None
        market = None
        if market_id is not None:
            market = _registry.find_market(market_id)
            if market is None:
                raise StoreError("unknown market %r" % (market_id,))
        else:
            market = _registry.market_for_source(source)
        if market is None:
            self.queue_review(
                REASON_AMBIGUOUS_MARKET,
                detail="source %r does not resolve to exactly one market; pass "
                       "market_id explicitly" % (source,),
                source=str(source or "") or None,
                payload={"source": source},
            )
            raise StoreError(
                "cannot resolve a market for source %r — pass market_id" % (source,)
            )
        try:
            normalized = _model.normalize_envelope(envelope, market)
        except _model.ModelError as exc:
            self.queue_review(
                REASON_NO_DETERMINISTIC_KEY,
                detail=str(exc),
                market_id=market.market_id,
                source=str(source or "") or None,
                payload={"entity": envelope.get("entity")},
            )
            raise StoreError(str(exc))
        return self.put_filing(normalized)

    def get(self, cik: Any) -> Optional[Dict[str, Any]]:
        """The documented adapter read: latest envelope by CIK.

        Kept CIK-shaped because that is the interface ``edgar.py`` was
        written against. :meth:`get_by_ticker` is the market-aware read
        every other caller should use."""
        entity = self.find_entity_by_cik(cik)
        if entity is None:
            return None
        return self.latest_filing(str(entity["entity_id"]))

    def get_by_ticker(self, market_id: str,
                      ticker: str) -> Optional[Dict[str, Any]]:
        entity = self.find_entity_by_ticker(market_id, ticker)
        if entity is None:
            return None
        return self.latest_filing(str(entity["entity_id"]))

    def get_by_entity_id(self, entity_id: str) -> Optional[Dict[str, Any]]:
        return self.latest_filing(entity_id)


# ── process-default store ───────────────────────────────────────────

_default_store: Optional[PublicMarketStore] = None
_default_lock = threading.Lock()


def get_store() -> PublicMarketStore:
    """Process-cached default store (``data/public_market.db``, or
    ``PUBLIC_MARKET_DB_PATH``). This is the symbol
    ``edgar._discover_store`` looks for."""
    global _default_store
    if _default_store is not None:
        return _default_store
    with _default_lock:
        if _default_store is None:
            _default_store = PublicMarketStore()
        return _default_store


def reset_store() -> None:
    """Test/ops hook: drop the cached default store (env re-read)."""
    global _default_store
    with _default_lock:
        if _default_store is not None:
            try:
                _default_store.close()
            except Exception:  # noqa: BLE001 — closing a dead handle is fine
                pass
        _default_store = None
