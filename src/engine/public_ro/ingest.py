"""Journaled bilanț ingestion — download, parse, normalize, upsert,
percentiles, dataset registry.

Data facts baked in (verified live, 2026-08): the mass files are
comma-separated ASCII with header ``CUI,CAEN,I1..I20`` (CRLF), empty
string = missing, whole-RON integers that CAN be negative (e.g. I10
capital), no quoting, no name/county/legal-form columns. Parsing is
STRICT: an empty field becomes NULL (never a silent 0) and junk raises
a typed ParseError with the line number.

License gate: FY2019-FY2023 are CC-BY-4.0 and FY2018-earlier carry the
portal's legacy "uk-ogl" label — both ingestable (license recorded on
the dataset row). situatii_financiare_2025 and _2024_actualizat have
license UNSET in CKAN: they are REFUSED unless
PUBLIC_INGEST_UNLICENSED_OK=1, with a loud NOTICE (the operator
confirms terms out-of-band before flipping that env).

Journal choice (documented per the architecture brief): the run-journal
EVENT_TYPES vocabulary is a closed frozenset and record_snapshot
expects pipeline envelope shapes, so this job journals its lifecycle
with the EXISTING vocabulary only — begin_run(run_kind="public_ingest",
file_hash=<sha256 of the dataset bytes>) at start, one PASS_DONE
completion event with row counts, and record_failure (DLQ) on any
error. Fine-grained progress lives in the ``datasets`` table, not in
journal events. A "public_ingest" run_kind is DURABLE from its first
event (no duplicate short-circuit — that only applies to
pipeline/resume kinds), so re-run dedupe happens UPSTREAM via the
sha256 registry check (skip-if-sha-known) instead of relying on the
journal. scripts/journal_cli.py refuses to drive these runs through
the pipeline-shaped resume (wrong_run_kind guard).

PS7 at this layer: the bilanț files are companies-only by construction
(legend: "SOCIETATI COMERCIALE"), so rows pass — but they only create
UNPUBLISHABLE company stubs. Publishability is granted exclusively by
the identification join (identification.py).
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from . import ckan
from .specs import SpecResolutionError, resolve_spec
from .store import INDICATOR_SLOTS, PublicRoStore

logger = logging.getLogger("engine.public_ro")

UNLICENSED_ENV = "PUBLIC_INGEST_UNLICENSED_OK"

#: Normalized CKAN license ids accepted without operator override.
ALLOWED_LICENSE_IDS = frozenset({"cc-by", "cc-by-4.0", "uk-ogl", "ogl-uk"})


class IngestError(RuntimeError):
    pass


class LicenseRefused(IngestError):
    """Dataset has no acceptable open license asserted in CKAN."""


class ParseError(IngestError):
    def __init__(self, line_no: int, detail: str) -> None:
        super().__init__("line %d: %s" % (line_no, detail))
        self.line_no = line_no
        self.detail = detail


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _notice(message: str) -> None:
    print("NOTICE  %s" % message)


# ── license gate ─────────────────────────────────────────────────────


def check_license(
    license_id: Optional[str], *, year: int, family: str
) -> Tuple[Optional[str], str]:
    """Return (license_id, license_note) or raise LicenseRefused.

    Unset license (the verified state of situatii_financiare_2025 and
    _2024_actualizat) refuses unless PUBLIC_INGEST_UNLICENSED_OK=1."""
    norm = (license_id or "").strip().lower()
    if norm in ALLOWED_LICENSE_IDS:
        note = "open license asserted in CKAN (%s)" % norm
        if norm in ("uk-ogl", "ogl-uk"):
            note += " — legacy portal label on pre-2019 datasets"
        return norm, note
    if os.environ.get(UNLICENSED_ENV) == "1":
        _notice(
            "public_ingest: FY%s %s has NO acceptable license asserted in "
            "CKAN (license_id=%r); ingesting ONLY because %s=1 — the "
            "operator has confirmed reuse terms out-of-band"
            % (year, family, license_id, UNLICENSED_ENV)
        )
        return norm or None, (
            "UNLICENSED in CKAN; operator override via %s=1" % UNLICENSED_ENV
        )
    raise LicenseRefused(
        "FY%s %s: CKAN asserts no acceptable open license "
        "(license_id=%r). The two newest datasets (2025, "
        "2024_actualizat) are known-unset. Set %s=1 only after "
        "confirming reuse terms with the publisher."
        % (year, family, license_id, UNLICENSED_ENV)
    )


# ── strict parsing ───────────────────────────────────────────────────


def _parse_int(raw: str, line_no: int, col: str) -> Optional[int]:
    text = raw.strip()
    if text == "":
        return None  # empty = missing — NEVER a silent 0
    try:
        return int(text)
    except ValueError:
        raise ParseError(line_no, "column %s is not an integer: %r" % (col, raw))


def parse_bilant(text: str) -> Tuple[List[str], Iterable[Dict[str, Any]]]:
    """Parse a WEB_* .txt data file. Returns (source_codes, row iter).
    Header is CUI,CAEN,<source i-codes>; rows are strict."""
    lines = text.splitlines()
    if not lines:
        raise ParseError(0, "empty data file")
    header = [h.strip().upper() for h in lines[0].split(",")]
    if len(header) < 3 or header[0] != "CUI" or header[1] != "CAEN":
        raise ParseError(1, "unexpected header (want CUI,CAEN,I..): %r" % lines[0][:120])
    source_codes = header[2:]

    def rows() -> Iterable[Dict[str, Any]]:
        for idx, line in enumerate(lines[1:], start=2):
            if not line.strip():
                continue
            fields = line.split(",")
            if len(fields) != len(header):
                raise ParseError(
                    idx,
                    "expected %d fields, got %d" % (len(header), len(fields)),
                )
            cui_text = fields[0].strip()
            if not cui_text.isdigit():
                raise ParseError(idx, "CUI is not numeric: %r" % fields[0])
            values: Dict[str, Optional[int]] = {}
            for col, raw in zip(source_codes, fields[2:]):
                values[col] = _parse_int(raw, idx, col)
            yield {
                "cui": int(cui_text),
                "caen": fields[1].strip() or None,
                "values": values,
            }

    return source_codes, rows()


# ── derived fields ───────────────────────────────────────────────────


def derive_fields(ind: Dict[str, Optional[int]]) -> Dict[str, Optional[int]]:
    """total_assets = i1+i2+i6 (Active totale is NOT a source column);
    net_result = i18 - i19 (profit and loss are separate non-negative
    columns).

    ABSENT != ZERO, and for total_assets that means ALL THREE components
    are REQUIRED. With one empty the total is UNKNOWN — not the sum of
    the rest: a partial sum asserts a magnitude the file does not
    support, and snapshot's indicators block would honestly OMIT the very
    component the derived total silently counted as zero.

    net_result is deliberately NOT symmetric with that rule. i18/i19 are
    a mutually EXCLUSIVE pair (profit net / pierdere neta, both
    non-negative): an empty side reports "no result on this side", not a
    hole, and requiring both would refuse the ordinary filing. The
    FactsGateway summary tier and the golden corpus read the same
    or-semantics, so do not "fix" this into agreement with the sum rule.
    """
    i1, i2, i6 = ind.get("i1"), ind.get("i2"), ind.get("i6")
    if i1 is None or i2 is None or i6 is None:
        total_assets: Optional[int] = None
    else:
        total_assets = i1 + i2 + i6
    profit, loss = ind.get("i18"), ind.get("i19")
    if profit is None and loss is None:
        net_result: Optional[int] = None
    else:
        net_result = (profit or 0) - (loss or 0)
    return {"total_assets": total_assets, "net_result": net_result}


# ── polite download ──────────────────────────────────────────────────


def download(
    url: str,
    fetcher: Optional[ckan.Fetcher] = None,
    *,
    retries: int = 3,
    backoff_base: float = 5.0,
    sleeper: Callable[[float], None] = time.sleep,
) -> bytes:
    """Full-file sequential download with exponential backoff.
    data.gov.ro ignores HTTP Range headers (verified) — no partial
    fetch, no parallelism (politeness)."""
    fetch = fetcher or ckan.default_fetcher
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return fetch(url)
        except Exception as exc:  # noqa: BLE001 — retried, then raised
            last_exc = exc
            if attempt < retries:
                sleeper(backoff_base * (2**attempt))
    raise IngestError("download failed after %d attempts: %s: %s" % (
        retries + 1, type(last_exc).__name__, last_exc))


# ── percentiles ──────────────────────────────────────────────────────

PERCENTILE_METRICS = {
    "revenue": "i13",
    "net_result": "net_result",
    "total_assets": "total_assets",
    "employees": "i20",
}

_QUANTILES = (("p10", 0.10), ("p25", 0.25), ("p50", 0.50),
              ("p75", 0.75), ("p90", 0.90))


def _percentile(sorted_vals: List[float], q: float) -> float:
    """Linear interpolation between closest ranks (numpy 'linear')."""
    if not sorted_vals:
        raise ValueError("empty")
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return float(sorted_vals[lo]) * (1 - frac) + float(sorted_vals[hi]) * frac


def compute_percentiles(store: PublicRoStore, year: int) -> int:
    """Recompute the (year, caen2) percentile rows for every metric,
    plus a year-wide all-sector row (caen2=None). Only non-NULL values
    enter a distribution; a group with n=0 writes nothing (absence is
    never reconstructed as a measurement)."""
    rows = store._conn.execute(  # internal read; store owns the schema
        "SELECT caen, i13, i20, total_assets, net_result FROM filings "
        "WHERE year=?",
        (int(year),),
    ).fetchall()
    groups: Dict[Optional[str], List[Dict[str, Any]]] = {}
    for r in rows:
        d = dict(r)
        caen2 = (d.get("caen") or "")[:2] or None
        groups.setdefault(caen2, []).append(d)
        groups.setdefault(None, []).append(d)

    out: List[Dict[str, Any]] = []
    for caen2, members in sorted(
        groups.items(), key=lambda kv: (kv[0] is not None, kv[0] or "")
    ):
        for metric, col in PERCENTILE_METRICS.items():
            vals = sorted(
                float(m[col]) for m in members if m.get(col) is not None
            )
            if not vals:
                continue
            row: Dict[str, Any] = {
                "caen2": caen2, "county": None, "size_band": None,
                "metric": metric, "n": len(vals),
            }
            for name, q in _QUANTILES:
                row[name] = _percentile(vals, q)
            out.append(row)
    return store.replace_percentiles(year, out)


# ── the journaled job ────────────────────────────────────────────────


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return "scandia-engine@%s" % version("scandia-engine")
    except Exception:  # noqa: BLE001 — not installed as a dist locally
        return "scandia-engine@dev"


def _journal_from_env() -> Optional[Any]:
    try:
        from engine.journal.hooks import journal_from_env

        return journal_from_env()
    except Exception:  # noqa: BLE001 — journaling never blocks ingest
        return None


def ingest_year(
    store: PublicRoStore,
    *,
    year: int,
    family: str,
    data_bytes: bytes,
    spec_text: str,
    source_url: Optional[str] = None,
    resource_id: Optional[str] = None,
    license_id: Optional[str] = None,
    journal: Optional[Any] = None,
    recompute_percentiles: bool = True,
) -> Dict[str, Any]:
    """Ingest one (year, family) data file end-to-end. Returns a
    summary dict; ``{"skipped": True}`` when the exact bytes (sha256)
    were already ingested (the dedupe)."""
    if family not in ("UU", "BL", "ONG"):
        raise IngestError("unsupported family %r" % family)
    if family == "ONG":
        # WEB_ONG has its own 46-indicator schema + CAENO column —
        # unmodeled this wave; honest refusal beats silent misreads.
        raise IngestError(
            "family ONG has a distinct 46-indicator schema not yet "
            "modeled — refusing rather than misreading"
        )

    sha = sha256_hex(data_bytes)
    existing = store.dataset_by_sha(sha)
    if existing is not None:
        _notice(
            "public_ingest: FY%s %s sha256 %s already ingested as %s — skip"
            % (year, family, sha[:12], existing["dataset_id"])
        )
        return {"skipped": True, "dataset_id": existing["dataset_id"],
                "sha256": sha}

    resolved_license, license_note = check_license(
        license_id, year=year, family=family
    )
    # Spec resolution BEFORE any row is touched — a year+family whose
    # spec cannot be resolved is refused (SpecResolutionError).
    code_map = resolve_spec(spec_text, year=year, family=family)

    journal = journal if journal is not None else _journal_from_env()
    handle = None
    if journal is not None:
        try:
            handle = journal.begin_run(
                file_hash=sha,
                document_id="public_ro:%d:%s" % (year, family),
                engine_version=_engine_version(),
                run_kind="public_ingest",
                extra_payload={"year": int(year), "family": family},
            )
        except Exception:  # noqa: BLE001
            logger.exception("public_ingest: journal begin_run failed")
            handle = None

    dataset_id = "%d_%s_%s" % (int(year), family, sha[:12])
    try:
        source_codes, rows = parse_bilant(
            data_bytes.decode("ascii", errors="strict")
        )
        unknown = [c for c in source_codes if c not in code_map]
        if unknown:
            raise SpecResolutionError(
                year, family,
                "data header carries codes absent from the spec: %s"
                % ", ".join(unknown),
            )
        row_count = 0
        for row in rows:
            indicators: Dict[str, Optional[int]] = {
                slot: None for slot in INDICATOR_SLOTS
            }
            for source_code, value in row["values"].items():
                indicators[code_map[source_code]] = value
            derived = derive_fields(indicators)
            store.upsert_filing(
                cui=row["cui"], year=int(year), family=family,
                dataset_id=dataset_id, indicators=indicators,
                total_assets=derived["total_assets"],
                net_result=derived["net_result"], caen=row["caen"],
            )
            store.ensure_company_stub(row["cui"], row["caen"])
            row_count += 1

        store.register_dataset(
            dataset_id=dataset_id, year=int(year), family=family,
            sha256=sha, source_url=source_url, resource_id=resource_id,
            license_id=resolved_license, license_note=license_note,
            row_count=row_count,
        )
        if recompute_percentiles:
            compute_percentiles(store, int(year))

        if handle is not None:
            try:
                handle.emit(
                    "PASS_DONE",
                    {"stage": "public_ingest", "dataset_id": dataset_id,
                     "rows": row_count},
                )
                handle.flush()
            except Exception:  # noqa: BLE001
                logger.exception("public_ingest: journal completion failed")
        return {
            "skipped": False, "dataset_id": dataset_id, "sha256": sha,
            "rows": row_count, "license_id": resolved_license,
        }
    except Exception as exc:
        if handle is not None and journal is not None:
            try:
                journal.record_failure(
                    handle,
                    stage="public_ingest",
                    error_type=type(exc).__name__,
                    message=str(exc)[:500],
                )
            except Exception:  # noqa: BLE001
                logger.exception("public_ingest: DLQ write failed")
        raise
