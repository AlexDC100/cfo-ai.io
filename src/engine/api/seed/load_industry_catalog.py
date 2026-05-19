"""Idempotent loader for the industry intelligence catalog (Phase A).

Reads the two YAML seed files in this directory and upserts them into
the Phase-A tables created by
`supabase/schema_phase_industry_intelligence.sql`:

  - industries.yaml             → industry_profiles
  - caen_industry_mappings.yaml → caen_industry_mappings

Idempotent. Safe to re-run after editing the YAMLs — upsert keys are:
  · industry_profiles.key                (unique)
  · caen_industry_mappings.caen_code    (primary key)

USAGE
=====
    # Real run (requires SUPABASE env vars; writes to DB):
    .venv/bin/python -m engine.api.seed.load_industry_catalog

    # Dry run — parses YAMLs, prints what would be written, exits 0
    # without contacting Supabase. Use for CI and local pre-flight:
    .venv/bin/python -m engine.api.seed.load_industry_catalog --dry-run

    # Verify the four calibration mappings round-trip cleanly. Pulls
    # them from the live DB and confirms industry_key + parent. Exits
    # non-zero if any mapping is wrong / missing:
    .venv/bin/python -m engine.api.seed.load_industry_catalog --verify

WHY YAML (not JSON like benchmarks_seed.json)
=============================================
The CAEN catalog is human-edited and bilingual; comments + multi-line
descriptions stay readable in YAML. JSON would push us toward an
admin UI just to keep the file maintainable, and we don't need one yet.

LOAD ORDER MATTERS
==================
1. industry_profiles    — parents first (where parent_key is null),
                          then children (foreign-keys parent_key →
                          industry_profiles(key)).
2. caen_industry_mappings — must run after profiles, because every
                            row's industry_key (and optional
                            parent_industry_key) references
                            industry_profiles(key).

CALIBRATION GUARDRAIL
=====================
After every real (non-dry-run) load, the script automatically
re-fetches the 4 calibration CAENs and asserts the mapping matches
what was loaded. A spec drift (e.g., yaml said 1013 → poultry by
mistake) fails the loader instead of corrupting production.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

# Lazy-import yaml so `--dry-run --help` works without the dep.
try:
    import yaml  # type: ignore
except ImportError as exc:  # pragma: no cover - import error path
    print(
        "PyYAML is required. Install via `pip install pyyaml` or "
        "include it in requirements.txt.",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────
# Paths + calibration anchors
# ──────────────────────────────────────────────────────────────────────

_HERE = Path(__file__).parent
_INDUSTRIES_YAML = _HERE / "industries.yaml"
_MAPPINGS_YAML = _HERE / "caen_industry_mappings.yaml"
# Optional — peer_candidates is loaded only when the file exists, so
# pre-Phase-3 deployments keep working.
_PEERS_YAML = _HERE / "peer_candidates.yaml"

# The four calibration mappings — these MUST land correctly or the
# whole industry-intelligence stack returns wrong benchmarks for the
# tenants we already onboarded. If yaml drift breaks any of them, the
# loader fails closed.
CALIBRATION_MAPPINGS: List[Tuple[str, str, str]] = [
    # (caen_code, expected_industry_key, expected_parent_industry_key)
    ("1013", "packaged_canned_meat_prepared_foods", "food_manufacturing"),
    ("4511", "automotive_retail_distribution",     "trade_distribution_generic"),
    ("6820", "real_estate_commercial_rental",      "real_estate"),
    ("7830", "employment_services",                "professional_services_generic"),
]


# ──────────────────────────────────────────────────────────────────────
# YAML → row builders
# ──────────────────────────────────────────────────────────────────────

def _load_yaml(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Seed file missing: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(
            f"{path.name} must be a YAML list of records, got {type(raw).__name__}"
        )
    return raw


def _industry_row(rec: Dict[str, Any]) -> Dict[str, Any]:
    """Map an industries.yaml record to an industry_profiles row.

    EVERY row returns the SAME set of keys. PostgREST bulk-upsert
    rejects with `PGRST102: All object keys must match` if dicts in
    the same batch have different keys.

    NOT-NULL columns WITH defaults must be sent with their default
    value (not `None`) — PostgREST passes explicit nulls through and
    Postgres then rejects with 23502 (not-null violation) instead of
    falling back to the column default. The schema defaults live in
    supabase/schema_phase_industry_intelligence.sql and are mirrored
    below.
    """
    required = ("key", "display_name", "sector")
    for col in required:
        if not rec.get(col):
            raise ValueError(f"industry_profiles row missing required {col}: {rec!r}")
    return {
        "key": rec["key"],
        "display_name": rec["display_name"],
        "sector": rec["sector"],
        # nullable in schema — None is fine
        "parent_key": rec.get("parent_key"),
        "caen_codes": rec.get("caen_codes") or [],
        # NOT NULL with default; we keep the loader-defaults aligned
        # with the schema so a row missing the field in YAML still
        # lands cleanly.
        "is_active": bool(rec.get("is_active", True)),
        "benchmark_depth": rec.get("benchmark_depth") or "directional",
        "confidence_default": (
            rec["confidence_default"] if rec.get("confidence_default") is not None else 0.7
        ),
        "source_type": rec.get("source_type") or "seed_v1",
        # nullable
        "display_name_ro": rec.get("display_name_ro"),
        "description": rec.get("description"),
    }


def _mapping_row(rec: Dict[str, Any]) -> Dict[str, Any]:
    """Map a caen_industry_mappings.yaml record to a DB row.

    Uniform key set + schema-aligned defaults (see _industry_row).
    Schema: caen_code PK · caen_label_en NOT NULL · industry_key NOT NULL ·
    match_quality NOT NULL · confidence NOT NULL default 0.9 · the rest nullable.
    """
    required = ("caen_code", "caen_label_en", "industry_key", "match_quality")
    for col in required:
        if rec.get(col) in (None, ""):
            raise ValueError(
                f"caen_industry_mappings row missing required {col}: {rec!r}"
            )
    return {
        "caen_code": str(rec["caen_code"]).strip(),
        "caen_label_en": rec["caen_label_en"],
        "industry_key": rec["industry_key"],
        "match_quality": rec["match_quality"],
        # NOT NULL with default 0.9 — substitute when absent.
        "confidence": rec["confidence"] if rec.get("confidence") is not None else 0.9,
        # nullable
        "caen_label_ro": rec.get("caen_label_ro"),
        "parent_industry_key": rec.get("parent_industry_key"),
        "notes": rec.get("notes"),
    }


def _peer_row(rec: Dict[str, Any]) -> Dict[str, Any]:
    """Map a peer_candidates.yaml record to a DB row.

    Uniform key set + schema-aligned defaults. Schema NOT-NULL-with-default
    columns: country='RO', source='internal_demo', has_uploaded_financials=false,
    is_internal_brand_default=false.
    """
    if not rec.get("industry_key") or not rec.get("company_name"):
        raise ValueError(f"peer_candidates row missing industry_key/company_name: {rec!r}")
    return {
        "industry_key": rec["industry_key"],
        "company_name": rec["company_name"],
        # NOT NULL with defaults — substitute when absent
        "country": rec.get("country") or "RO",
        "source": rec.get("source") or "internal_demo",
        "has_uploaded_financials": bool(rec.get("has_uploaded_financials", False)),
        "is_internal_brand_default": bool(rec.get("is_internal_brand_default", False)),
        # nullable
        "notes": rec.get("notes"),
    }


# ──────────────────────────────────────────────────────────────────────
# Pre-flight validation (catches FK errors before they hit the DB)
# ──────────────────────────────────────────────────────────────────────

def _validate_local(industries: List[Dict[str, Any]],
                    mappings: List[Dict[str, Any]]) -> None:
    """Run all checks that don't need a database connection:
      · all `key` values unique in industries.yaml
      · every parent_key points at an existing key
      · every mapping.industry_key + mapping.parent_industry_key resolve
        to an industry that exists in industries.yaml
      · all 4 calibration mappings are present
    Raises ValueError on the first failure with a precise location.
    """
    keys = [r.get("key") for r in industries]
    dupes = {k for k in keys if keys.count(k) > 1}
    if dupes:
        raise ValueError(f"Duplicate industry keys in industries.yaml: {sorted(dupes)}")
    key_set = set(keys)
    for r in industries:
        parent = r.get("parent_key")
        if parent and parent not in key_set:
            raise ValueError(
                f"industries.yaml: parent_key '{parent}' for industry "
                f"'{r['key']}' does not exist in this file."
            )

    caen_seen: Dict[str, str] = {}
    for m in mappings:
        caen = str(m.get("caen_code", "")).strip()
        if not caen:
            raise ValueError(f"caen_industry_mappings.yaml: blank caen_code in {m!r}")
        if caen in caen_seen:
            raise ValueError(
                f"caen_industry_mappings.yaml: duplicate caen_code {caen}"
            )
        caen_seen[caen] = m.get("industry_key", "")
        if m.get("industry_key") not in key_set:
            raise ValueError(
                f"caen_industry_mappings.yaml: caen {caen} → industry_key "
                f"'{m.get('industry_key')}' which is not in industries.yaml."
            )
        parent_industry_key = m.get("parent_industry_key")
        if parent_industry_key and parent_industry_key not in key_set:
            raise ValueError(
                f"caen_industry_mappings.yaml: caen {caen} → "
                f"parent_industry_key '{parent_industry_key}' which is not "
                f"in industries.yaml."
            )

    # Calibration anchors must exist locally before we attempt a load.
    for caen, expected_industry, expected_parent in CALIBRATION_MAPPINGS:
        if caen not in caen_seen:
            raise ValueError(
                f"Calibration drift: caen {caen} is not in "
                f"caen_industry_mappings.yaml (expected → {expected_industry})."
            )
        if caen_seen[caen] != expected_industry:
            raise ValueError(
                f"Calibration drift: caen {caen} → '{caen_seen[caen]}', "
                f"expected '{expected_industry}'."
            )


# ──────────────────────────────────────────────────────────────────────
# DB writes (admin / service-role)
# ──────────────────────────────────────────────────────────────────────

def _upsert_industries(client: Any, rows: List[Dict[str, Any]]) -> None:
    """Two-pass upsert so FK self-reference (parent_key) is satisfied:
        pass 1: all rows whose parent_key is null  (sectors / roots)
        pass 2: all rows whose parent_key is non-null  (sub-industries)
    """
    roots = [r for r in rows if not r.get("parent_key")]
    children = [r for r in rows if r.get("parent_key")]
    if roots:
        client.upsert("industry_profiles", roots, on_conflict="key", returning=False)
        logger.info("Upserted %d root industries.", len(roots))
    if children:
        client.upsert("industry_profiles", children, on_conflict="key", returning=False)
        logger.info("Upserted %d sub-industries.", len(children))


def _upsert_mappings(client: Any, rows: List[Dict[str, Any]]) -> None:
    """PostgREST upsert keyed on the table's primary key (caen_code)."""
    client.upsert(
        "caen_industry_mappings",
        rows,
        on_conflict="caen_code",
        returning=False,
    )
    logger.info("Upserted %d caen_industry_mappings.", len(rows))


def _upsert_peers(client: Any, rows: List[Dict[str, Any]]) -> None:
    """PostgREST upsert keyed on the (industry_key, company_name) unique
    constraint declared in the Phase A schema."""
    if not rows:
        return
    client.upsert(
        "peer_candidates",
        rows,
        on_conflict="industry_key,company_name",
        returning=False,
    )
    logger.info("Upserted %d peer_candidates.", len(rows))


# ──────────────────────────────────────────────────────────────────────
# Calibration round-trip verification (post-load)
# ──────────────────────────────────────────────────────────────────────

def _verify_calibration(client: Any) -> List[str]:
    """Fetch the 4 calibration CAENs from the DB and confirm they match
    CALIBRATION_MAPPINGS exactly. Returns a list of error strings
    (empty list = all good)."""
    errors: List[str] = []
    for caen, expected_industry, expected_parent in CALIBRATION_MAPPINGS:
        rows = client.select(
            "caen_industry_mappings",
            filters={"caen_code": f"eq.{caen}"},
            columns="caen_code,industry_key,parent_industry_key",
        )
        if not rows:
            errors.append(f"FAIL: caen {caen} missing from caen_industry_mappings.")
            continue
        row = rows[0]
        if row.get("industry_key") != expected_industry:
            errors.append(
                f"FAIL: caen {caen} → industry_key "
                f"'{row.get('industry_key')}' (expected '{expected_industry}')"
            )
        if row.get("parent_industry_key") != expected_parent:
            errors.append(
                f"FAIL: caen {caen} → parent_industry_key "
                f"'{row.get('parent_industry_key')}' "
                f"(expected '{expected_parent}')"
            )
    return errors


# ──────────────────────────────────────────────────────────────────────
# CLI entry point
# ──────────────────────────────────────────────────────────────────────

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed.load_industry_catalog",
        description=(
            "Idempotent loader for industry_profiles + "
            "caen_industry_mappings (Phase A)."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Parse + validate YAMLs; do not contact Supabase.",
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Verify the 4 calibration CAENs against the live DB and exit.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Log every row built (very chatty — for debugging only).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        format="[%(levelname)s] %(message)s",
        level=logging.DEBUG if args.verbose else logging.INFO,
    )

    # ── --verify path: skips parsing local YAMLs entirely ─────────────
    if args.verify:
        # Local import keeps `--dry-run` working when env vars are missing.
        from .. import _supabase  # type: ignore
        with _supabase.admin() as client:
            errors = _verify_calibration(client)
        if errors:
            for e in errors:
                print(e, file=sys.stderr)
            return 1
        print("All 4 calibration CAENs verified against live DB.")
        return 0

    # ── parse + validate locally ─────────────────────────────────────
    logger.info("Reading %s", _INDUSTRIES_YAML.name)
    industries_raw = _load_yaml(_INDUSTRIES_YAML)
    logger.info("Reading %s", _MAPPINGS_YAML.name)
    mappings_raw = _load_yaml(_MAPPINGS_YAML)

    # Peers are optional — load if the file is present. Existing
    # deployments that never created peer_candidates.yaml keep working.
    peers_raw: List[Dict[str, Any]] = []
    if _PEERS_YAML.exists():
        logger.info("Reading %s", _PEERS_YAML.name)
        peers_raw = _load_yaml(_PEERS_YAML)

    _validate_local(industries_raw, mappings_raw)

    # Validate peers FK locally — every industry_key must exist in
    # industries.yaml or the upsert will fail server-side.
    key_set = {r["key"] for r in industries_raw}
    for p in peers_raw:
        if p.get("industry_key") not in key_set:
            raise ValueError(
                f"peer_candidates.yaml: industry_key '{p.get('industry_key')}' "
                f"for company '{p.get('company_name')}' not in industries.yaml."
            )

    logger.info(
        "Local validation passed: %d industries, %d caen mappings, %d peer candidates.",
        len(industries_raw), len(mappings_raw), len(peers_raw),
    )

    industry_rows = [_industry_row(r) for r in industries_raw]
    mapping_rows = [_mapping_row(r) for r in mappings_raw]
    peer_rows = [_peer_row(r) for r in peers_raw]

    if args.verbose:
        for r in industry_rows:
            logger.debug("industry: %s", r)
        for r in mapping_rows:
            logger.debug("mapping:  %s", r)
        for r in peer_rows:
            logger.debug("peer:     %s", r)

    if args.dry_run:
        print(
            f"DRY RUN: would upsert {len(industry_rows)} industries, "
            f"{len(mapping_rows)} caen mappings, {len(peer_rows)} peer candidates. "
            f"All 4 calibration CAENs found in local YAML."
        )
        return 0

    # ── write to DB via admin (service-role) client ──────────────────
    from .. import _supabase  # type: ignore
    with _supabase.admin() as client:
        _upsert_industries(client, industry_rows)
        _upsert_mappings(client, mapping_rows)
        _upsert_peers(client, peer_rows)

        # Post-load: verify the round-trip. Fail closed if any drift.
        errors = _verify_calibration(client)
        if errors:
            for e in errors:
                print(e, file=sys.stderr)
            print(
                "Loader wrote rows but calibration verification FAILED. "
                "Inspect DB; do NOT consider this run successful.",
                file=sys.stderr,
            )
            return 1

    print(
        f"OK: loaded {len(industry_rows)} industries + "
        f"{len(mapping_rows)} caen mappings. "
        f"All 4 calibration CAENs verified."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
