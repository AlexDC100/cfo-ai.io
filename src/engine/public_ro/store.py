"""SQLite layer for the public RO company spine — data/public_ro.db.

A SEPARATE database file from engine.db by architecture decision
(engine.db lock contention; Supabase is out at ~7.5M company-year
rows). stdlib sqlite3 only — no SQLAlchemy. Connections are opened
with PRAGMA journal_mode=WAL and busy_timeout=5000 so the FastAPI
serving lanes read while the ingest job writes.

Indicators are stored as EXACT INTEGER whole RON (data.gov.ro files
publish whole-RON ints, sometimes negative). Every read API returns
provenance-carrying dicts (dataset id / sha / license / fetch date
joined in) so the serving lanes never invent provenance.

Tables ``takedowns`` and ``funnel_events`` are schema-only here —
lanes 5/6 own their write paths.

PS7 (PFA/II/IF exclusion): ``companies.publishable`` defaults to 0 and
flips to 1 ONLY via the identification join (TIP_CONTRIB=PJ and not an
F-series trade-register number). Bilanț ingestion alone never makes a
CUI publishable.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

DB_ENV = "PUBLIC_RO_DB_PATH"
SCHEMA_VERSION = 1

#: Canonical indicator slots persisted on filings (see specs.py).
INDICATOR_SLOTS = tuple("i%d" % n for n in range(1, 22))


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_db_path() -> Path:
    env = os.environ.get(DB_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "public_ro.db"


_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS datasets (
        dataset_id TEXT PRIMARY KEY,
        year INTEGER NOT NULL,
        family TEXT NOT NULL CHECK (family IN ('UU','BL','ONG')),
        source_url TEXT,
        resource_id TEXT,
        sha256 TEXT NOT NULL UNIQUE,
        fetched_at TEXT NOT NULL,
        license_id TEXT,
        license_note TEXT,
        row_count INTEGER
    )""",
    """CREATE TABLE IF NOT EXISTS companies (
        cui INTEGER PRIMARY KEY,
        name TEXT,
        county TEXT,
        locality TEXT,
        caen TEXT,
        caen_rev TEXT,
        reg_number TEXT,
        tip_contrib TEXT,
        publishable INTEGER NOT NULL DEFAULT 0,
        name_source TEXT,
        updated_at TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name)",
    """CREATE TABLE IF NOT EXISTS filings (
        cui INTEGER NOT NULL,
        year INTEGER NOT NULL,
        family TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        %s,
        total_assets INTEGER,
        net_result INTEGER,
        caen TEXT,
        PRIMARY KEY (cui, year)
    )"""
    % ",\n        ".join("%s INTEGER" % slot for slot in INDICATOR_SLOTS),
    "CREATE INDEX IF NOT EXISTS idx_filings_year ON filings(year)",
    "CREATE INDEX IF NOT EXISTS idx_filings_year_caen ON filings(year, caen)",
    # Dimension columns use '' (not NULL) for "any" so they can sit in
    # the primary key — sqlite forbids expressions in a PK. The read
    # API maps None <-> '' at the boundary.
    """CREATE TABLE IF NOT EXISTS percentiles (
        year INTEGER NOT NULL,
        caen2 TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        size_band TEXT NOT NULL DEFAULT '',
        metric TEXT NOT NULL,
        p10 REAL, p25 REAL, p50 REAL, p75 REAL, p90 REAL,
        n INTEGER NOT NULL,
        PRIMARY KEY (year, metric, caen2, county, size_band)
    ) WITHOUT ROWID""",
    """CREATE TABLE IF NOT EXISTS takedowns (
        cui INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT,
        verified_by TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS funnel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        cui INTEGER,
        path TEXT,
        utm TEXT,
        ip_hash TEXT,
        ua_class TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_funnel_ts ON funnel_events(ts)",
]


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class PublicRoStore:
    """One connection per store instance; a lock serializes writes
    from this process (WAL + busy_timeout handles cross-process)."""

    def __init__(self, path: Optional[Path] = None) -> None:
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

    def __enter__(self) -> "PublicRoStore":
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

    # ── datasets registry ──────────────────────────────────────────

    def dataset_by_sha(self, sha256: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM datasets WHERE sha256=?", (sha256,)
        ).fetchone()
        return dict(row) if row else None

    def register_dataset(
        self,
        *,
        dataset_id: str,
        year: int,
        family: str,
        sha256: str,
        source_url: Optional[str],
        resource_id: Optional[str],
        license_id: Optional[str],
        license_note: Optional[str],
        row_count: Optional[int],
        fetched_at: Optional[str] = None,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO datasets(dataset_id, year, family, "
                "source_url, resource_id, sha256, fetched_at, license_id, "
                "license_note, row_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    dataset_id, year, family, source_url, resource_id,
                    sha256, fetched_at or _now_iso(), license_id,
                    license_note, row_count,
                ),
            )

    def dataset_registry(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM datasets ORDER BY year, family"
        ).fetchall()
        return [dict(r) for r in rows]

    # ── companies ──────────────────────────────────────────────────

    def ensure_company_stub(self, cui: int, caen: Optional[str]) -> None:
        """Bilanț-side upsert: creates the row if absent, refreshes
        caen. NEVER touches publishable/tip_contrib (PS7 — only the
        identification join grants publishability)."""
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO companies(cui, caen, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(cui) DO UPDATE SET "
                "caen=COALESCE(excluded.caen, companies.caen), "
                "updated_at=excluded.updated_at",
                (cui, caen, _now_iso()),
            )

    def set_identification(
        self,
        cui: int,
        *,
        name: Optional[str],
        county: Optional[str],
        locality: Optional[str],
        reg_number: Optional[str],
        tip_contrib: str,
        publishable: bool,
        name_source: str,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO companies(cui, name, county, locality, "
                "reg_number, tip_contrib, publishable, name_source, "
                "updated_at) VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(cui) DO UPDATE SET "
                "name=excluded.name, county=excluded.county, "
                "locality=excluded.locality, reg_number=excluded.reg_number, "
                "tip_contrib=excluded.tip_contrib, "
                "publishable=excluded.publishable, "
                "name_source=excluded.name_source, "
                "updated_at=excluded.updated_at",
                (
                    cui, name, county, locality, reg_number, tip_contrib,
                    1 if publishable else 0, name_source, _now_iso(),
                ),
            )

    def get_company(self, cui: int) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM companies WHERE cui=?", (int(cui),)
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["publishable"] = bool(out.get("publishable"))
        out["provenance"] = {
            "name_source": out.get("name_source"),
            "updated_at": out.get("updated_at"),
        }
        return out

    def search_companies(self, q: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Name-prefix + exact-CUI search over PUBLISHABLE companies
        only (unpublishable CUIs never surface, PS7)."""
        q = (q or "").strip()
        if not q:
            return []
        limit = max(1, min(int(limit), 100))
        params: List[Any] = []
        clauses = ["publishable=1"]
        if q.isdigit():
            clauses.append("(cui=? OR name LIKE ? ESCAPE '\\')")
            params.extend([int(q), _like_prefix(q)])
        else:
            clauses.append("name LIKE ? ESCAPE '\\' COLLATE NOCASE")
            params.append(_like_prefix(q))
        params.append(limit)
        rows = self._conn.execute(
            "SELECT cui, name, county, locality, caen FROM companies "
            "WHERE %s ORDER BY name LIMIT ?" % " AND ".join(clauses),
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    # ── filings ────────────────────────────────────────────────────

    def upsert_filing(
        self,
        *,
        cui: int,
        year: int,
        family: str,
        dataset_id: str,
        indicators: Dict[str, Optional[int]],
        total_assets: Optional[int],
        net_result: Optional[int],
        caen: Optional[str],
    ) -> None:
        cols = ["cui", "year", "family", "dataset_id"]
        vals: List[Any] = [int(cui), int(year), family, dataset_id]
        for slot in INDICATOR_SLOTS:
            cols.append(slot)
            vals.append(indicators.get(slot))
        cols += ["total_assets", "net_result", "caen"]
        vals += [total_assets, net_result, caen]
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO filings(%s) VALUES (%s)"
                % (",".join(cols), ",".join("?" * len(cols))),
                vals,
            )

    def get_filings(self, cui: int) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT f.*, d.sha256 AS dataset_sha256, "
            "d.source_url AS dataset_source_url, "
            "d.license_id AS dataset_license_id, "
            "d.fetched_at AS dataset_fetched_at "
            "FROM filings f LEFT JOIN datasets d "
            "ON d.dataset_id = f.dataset_id "
            "WHERE f.cui=? ORDER BY f.year",
            (int(cui),),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["provenance"] = {
                "source": "data.gov.ro/mfp",
                "dataset_id": d.get("dataset_id"),
                "dataset_sha256": d.pop("dataset_sha256", None),
                "source_url": d.pop("dataset_source_url", None),
                "license_id": d.pop("dataset_license_id", None),
                "fetch_date": d.pop("dataset_fetched_at", None),
            }
            out.append(d)
        return out

    def latest_year(self) -> Optional[int]:
        row = self._conn.execute("SELECT MAX(year) AS y FROM filings").fetchone()
        return int(row["y"]) if row and row["y"] is not None else None

    # ── sitemap / hubs ─────────────────────────────────────────────

    def sitemap_company_count(self) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM companies c WHERE c.publishable=1 "
            "AND EXISTS (SELECT 1 FROM filings f WHERE f.cui=c.cui)"
        ).fetchone()
        return int(row["n"])

    def companies_for_sitemap(
        self, shard: int, shard_size: int = 40000
    ) -> List[Dict[str, Any]]:
        """Deterministic shard iteration (ordered by CUI) over
        publishable companies that have at least one filing."""
        shard = max(0, int(shard))
        shard_size = max(1, int(shard_size))
        rows = self._conn.execute(
            "SELECT c.cui, c.name, c.county FROM companies c "
            "WHERE c.publishable=1 "
            "AND EXISTS (SELECT 1 FROM filings f WHERE f.cui=c.cui) "
            "ORDER BY c.cui LIMIT ? OFFSET ?",
            (shard_size, shard * shard_size),
        ).fetchall()
        return [dict(r) for r in rows]

    def hub_top_companies(
        self,
        *,
        year: int,
        caen2: Optional[str] = None,
        county: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Top publishable companies for a sector (2-digit CAEN) or
        county hub, ranked by revenue (canonical i13)."""
        limit = max(1, min(int(limit), 500))
        clauses = ["c.publishable=1", "f.year=?"]
        params: List[Any] = [int(year)]
        if caen2:
            clauses.append("substr(f.caen,1,2)=?")
            params.append(str(caen2)[:2])
        if county:
            clauses.append("c.county=? COLLATE NOCASE")
            params.append(county)
        params.append(limit)
        rows = self._conn.execute(
            "SELECT c.cui, c.name, c.county, f.caen, f.year, "
            "f.i13 AS revenue, f.net_result, f.total_assets, "
            "f.i20 AS employees, f.dataset_id "
            "FROM filings f JOIN companies c ON c.cui=f.cui "
            "WHERE %s ORDER BY (f.i13 IS NULL), f.i13 DESC, c.cui LIMIT ?"
            % " AND ".join(clauses),
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    # ── percentiles ────────────────────────────────────────────────

    # ── SEO contract surface (engine.public_ro.seo store contract) ────
    # seo.py + scripts/check_public_sitemaps.py were written against
    # these three names while the lanes built in parallel; they are the
    # documented iteration API for sitemap + hub generation. Kept here
    # (rather than renaming in seo) so the SEO engine can consume ANY
    # store that satisfies the documented shape.

    def publishable_companies(self) -> List[Dict[str, Any]]:
        """Every PJ company with >=1 filing — the sitemap-eligible set.

        Returns {cui, name, slug, county, years, latest_year, revenue}
        so the generator needs no second query per company. Thin
        (zero-filing) and unpublishable rows are excluded by the JOIN,
        which is the PS6/PS7 guarantee at its source.
        """
        rows = self._conn.execute(
            "SELECT c.cui, c.name, c.county, "
            "       GROUP_CONCAT(f.year) AS years_csv, "
            "       MAX(f.year) AS latest_year "
            "FROM companies c JOIN filings f ON f.cui = c.cui "
            "WHERE c.publishable = 1 "
            "GROUP BY c.cui, c.name, c.county ORDER BY c.cui"
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            row = dict(r)
            years = sorted(
                int(y) for y in str(row.pop("years_csv") or "").split(",") if y
            )
            latest = row.get("latest_year")
            revenue = None
            if latest is not None:
                hit = self._conn.execute(
                    "SELECT i13 FROM filings WHERE cui=? AND year=?",
                    (row["cui"], int(latest)),
                ).fetchone()
                if hit is not None:
                    revenue = hit["i13"]
            row["years"] = years
            row["revenue"] = revenue
            out.append(row)
        return out

    def hub_keys(self, kind: str) -> List[Dict[str, Any]]:
        """Sector (caen2) or county hub keys with their company counts.

        Only publishable companies with filings are counted, so a hub
        can never advertise more companies than its page can list.
        """
        kind = str(kind or "").strip().lower()
        if kind in ("sector", "caen", "caen2"):
            rows = self._conn.execute(
                "SELECT substr(c.caen, 1, 2) AS slug_key, "
                "       COUNT(DISTINCT c.cui) AS company_count "
                "FROM companies c JOIN filings f ON f.cui = c.cui "
                "WHERE c.publishable = 1 AND c.caen IS NOT NULL "
                "AND length(c.caen) >= 2 "
                "GROUP BY slug_key ORDER BY slug_key"
            ).fetchall()
        elif kind in ("judet", "county"):
            rows = self._conn.execute(
                "SELECT c.county AS slug_key, "
                "       COUNT(DISTINCT c.cui) AS company_count "
                "FROM companies c JOIN filings f ON f.cui = c.cui "
                "WHERE c.publishable = 1 AND c.county IS NOT NULL "
                "AND c.county <> '' "
                "GROUP BY slug_key ORDER BY slug_key"
            ).fetchall()
        else:
            return []
        return [
            {"slug": str(r["slug_key"]),
             "label_ro": str(r["slug_key"]),
             "company_count": int(r["company_count"])}
            for r in rows if r["slug_key"]
        ]

    def dataset_version(self) -> Optional[Dict[str, Any]]:
        """The newest ingested dataset — {version, fetch_date} — or None
        before the first ingest (drives sitemap lastmod)."""
        row = self._conn.execute(
            "SELECT dataset_id, fetched_at FROM datasets "
            "ORDER BY fetched_at DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        fetched = str(row["fetched_at"] or "")
        return {"version": str(row["dataset_id"]),
                "fetch_date": fetched[:10] or None}

    def percentiles_epoch(self) -> str:
        """Monotonic counter bumped on every percentile recomputation.

        Page bytes are cached per (cui, year, dataset_version, lang), but
        a page also renders SECTOR percentile bars, and those come from a
        separate job whose output changes without any filing's
        dataset_id changing. Without this in the cache key a recomputed
        percentile set would never reach an already-cached page.
        """
        row = self._conn.execute(
            "SELECT value FROM schema_meta WHERE key='percentiles_epoch'"
        ).fetchone()
        return str(row["value"]) if row else "0"

    def replace_percentiles(
        self, year: int, rows: Iterable[Dict[str, Any]]
    ) -> int:
        count = 0
        with self._lock, self._conn:
            self._conn.execute(
                "DELETE FROM percentiles WHERE year=?", (int(year),)
            )
            # Bump BEFORE the inserts and inside the same transaction:
            # either the new rows and the new epoch are both visible, or
            # neither is. See percentiles_epoch().
            self._conn.execute(
                "INSERT INTO schema_meta(key, value) "
                "VALUES('percentiles_epoch', '1') "
                "ON CONFLICT(key) DO UPDATE SET "
                "value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
            )
            for row in rows:
                self._conn.execute(
                    "INSERT OR REPLACE INTO percentiles(year, caen2, county, "
                    "size_band, metric, p10, p25, p50, p75, p90, n) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        int(year), row.get("caen2") or "",
                        row.get("county") or "", row.get("size_band") or "",
                        row["metric"], row.get("p10"), row.get("p25"),
                        row.get("p50"), row.get("p75"), row.get("p90"),
                        int(row["n"]),
                    ),
                )
                count += 1
        return count

    def get_percentiles(
        self,
        *,
        year: int,
        metric: str,
        caen2: Optional[str] = None,
        county: Optional[str] = None,
        size_band: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM percentiles WHERE year=? AND metric=? "
            "AND caen2=? AND county=? AND size_band=?",
            (int(year), metric, caen2 or "", county or "", size_band or ""),
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        for dim in ("caen2", "county", "size_band"):
            out[dim] = out[dim] or None
        return out

    # ── takedowns (schema owner; lanes 5/6 drive the workflow) ─────

    def get_takedown(self, cui: int) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM takedowns WHERE cui=?", (int(cui),)
        ).fetchone()
        return dict(row) if row else None

    def set_takedown(
        self, cui: int, *, status: str, reason: str, verified_by: str
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO takedowns(cui, status, reason, "
                "verified_by, created_at) VALUES (?,?,?,?,?)",
                (int(cui), status, reason, verified_by, _now_iso()),
            )


def _like_prefix(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "%"
