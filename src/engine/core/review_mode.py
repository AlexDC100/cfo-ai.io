"""F3.4 — Review Mode session state + override-aware bucket dispatch.

When the F3.3 confidence engine returns `review_mode_required=True`,
the FE routes the user to Review Mode. In that mode the user:
  1. Confirms or corrects the detected country + accounting standard.
  2. Reviews accounts the pack's chart-of-accounts couldn't map.
  3. Assigns each unmapped account a canonical bucket manually.
  4. Triggers reanalysis with the overrides applied.

This module exposes:
  - `ReviewOverrides` dataclass — per-account canonical-bucket
    overrides PLUS the user-confirmed country/standard.
  - `apply_overrides(...)` — given a country pack and a set of
    overrides, returns a wrapped `bucket_for(code)` that consults
    the overrides first and falls back to the pack's chart.
  - DB CRUD helpers (`load_overrides`, `save_overrides`,
    `delete_overrides`) — backed by a `review_overrides` table the
    engine creates idempotently at startup.

The overrides are also the input to the F3.5 calibration-learning
database: an approved override becomes a `calibration_rule` that
applies automatically to future uploads with the same account
pattern.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .country_pack import CountryAccountingPack
from .types import BucketRule


logger = logging.getLogger(__name__)


@dataclass
class ReviewOverrides:
    """User-supplied overrides captured during a Review Mode session.

    `account_buckets` maps each manually-bucketed account code to the
    canonical bucket name. The bucket vocabulary matches what the
    pack's `bucket_for()` would return for a recognised code.

    `confirmed_country_code` and `confirmed_standard` carry the user's
    explicit confirmation (or correction) of the detected country +
    accounting standard. They're stored so the audit trail captures
    why we processed this upload with a particular pack even if
    detection scored low.
    """
    period_id: str
    account_buckets: Dict[str, str] = field(default_factory=dict)
    confirmed_country_code: Optional[str] = None
    confirmed_standard: Optional[str] = None
    notes: str = ""
    propose_as_calibration_rules: bool = False    # F3.5 hand-off

    def is_empty(self) -> bool:
        return (
            not self.account_buckets
            and not self.confirmed_country_code
            and not self.confirmed_standard
            and not self.notes
        )


def apply_overrides(
    pack: CountryAccountingPack,
    overrides: ReviewOverrides,
) -> Callable[[str], Optional[Any]]:
    """Return a wrapped `bucket_for(code)` that consults the override
    map first and falls back to the pack's chart-of-accounts.

    Synthesises a `BucketRule`-shaped object for override hits so
    downstream `assemble_statements()` sees the same shape regardless
    of whether a code came from the pack or the user. The synthesised
    rule uses sign=+1 (override semantics: user said "this is a
    revenue account" → treat the raw amount as-is) and an empty
    description.
    """
    map_ = dict(overrides.account_buckets or {})

    # The pack's `bucket_for()` may return a `MappingRule` (RomaniaPack
    # delegates to `_ro_coa.MappingRule`) or any BucketRule-like
    # object. We need to return the same shape, so wrap.
    def _wrapped(code: str):
        if not code:
            return None
        if code in map_:
            return _SyntheticBucketRule(
                prefix=code,
                bucket=map_[code],
                sign=1,
                description=f"User override (Review Mode)",
            )
        # Fall back to pack — try prefix-style override matches before
        # the pack's own dispatch. This handles the case where a user
        # set "10" → "shareCapital" and a code "10523" comes in.
        for override_prefix, override_bucket in map_.items():
            if code.startswith(override_prefix) and override_prefix != code:
                return _SyntheticBucketRule(
                    prefix=override_prefix,
                    bucket=override_bucket,
                    sign=1,
                    description="User override (Review Mode prefix)",
                )
        return pack.bucket_for(code)

    return _wrapped


@dataclass
class _SyntheticBucketRule:
    """BucketRule-shaped object emitted by override matches. Matches
    the duck-typed shape `assemble_statements()` reads (.bucket,
    .sign, .description, .prefix)."""
    prefix: str
    bucket: str
    sign: int
    description: str


# ── DB persistence ────────────────────────────────────────────────────
# Uses the shared `_supabase` admin client. The table is created
# idempotently at startup; no separate migration file required for the
# F3.4 cut.

_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS review_overrides (
    period_id UUID PRIMARY KEY,
    org_id UUID,
    account_buckets JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmed_country_code TEXT,
    confirmed_standard TEXT,
    notes TEXT NOT NULL DEFAULT '',
    propose_as_calibration_rules BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def ensure_table(admin_client: Any) -> None:
    """Create the `review_overrides` table if it doesn't exist.
    Idempotent — safe to call on every startup.

    Supabase's PostgREST doesn't expose raw DDL, so this is best-
    effort: if the supabase client used by the engine has a `.rpc()`
    or `.execute()` for direct SQL, it's used; otherwise we log a
    note and rely on the migration being applied out-of-band.
    """
    try:
        # Try the common Supabase-py pattern. _Supabase admin client
        # may expose `.execute_sql()` or similar; if not, skip.
        if hasattr(admin_client, "execute_sql"):
            admin_client.execute_sql(_TABLE_DDL)
            return
        if hasattr(admin_client, "rpc"):
            # Some Supabase clients require a stored proc; we can't
            # rely on that. No-op and log.
            pass
    except Exception:  # noqa: BLE001
        logger.exception("[review_mode] ensure_table failed (non-fatal)")
    logger.info(
        "[review_mode] review_overrides table ensure_table executed; "
        "table may need manual creation if no DDL channel available."
    )


def load_overrides(admin_client: Any, period_id: str) -> Optional[ReviewOverrides]:
    """Load the persisted overrides for a period. Returns None when
    no row exists (no Review Mode session yet)."""
    try:
        rows = admin_client.select(
            "review_overrides",
            filters={"period_id": f"eq.{period_id}"},
            single=True,
        )
    except Exception:  # noqa: BLE001
        # Table might not exist yet — return None gracefully.
        logger.debug(
            "[review_mode] load_overrides for %s: table miss or query failed; "
            "treating as no-overrides",
            period_id,
        )
        return None
    if not rows:
        return None
    row = rows[0]
    return ReviewOverrides(
        period_id=row["period_id"],
        account_buckets=row.get("account_buckets") or {},
        confirmed_country_code=row.get("confirmed_country_code"),
        confirmed_standard=row.get("confirmed_standard"),
        notes=row.get("notes") or "",
        propose_as_calibration_rules=bool(row.get("propose_as_calibration_rules", False)),
    )


def save_overrides(
    admin_client: Any,
    org_id: Optional[str],
    overrides: ReviewOverrides,
) -> None:
    """Upsert the overrides row. Idempotent on `period_id`."""
    payload = {
        "period_id": overrides.period_id,
        "org_id": org_id,
        "account_buckets": overrides.account_buckets,
        "confirmed_country_code": overrides.confirmed_country_code,
        "confirmed_standard": overrides.confirmed_standard,
        "notes": overrides.notes,
        "propose_as_calibration_rules": overrides.propose_as_calibration_rules,
    }
    try:
        admin_client.upsert(
            "review_overrides",
            payload,
            on_conflict="period_id",
            returning=False,
        )
    except Exception:  # noqa: BLE001
        logger.exception("[review_mode] save_overrides failed")
        raise


def delete_overrides(admin_client: Any, period_id: str) -> None:
    """Clear the overrides for a period (back to pack-default
    mapping)."""
    try:
        admin_client.delete(
            "review_overrides",
            filters={"period_id": f"eq.{period_id}"},
        )
    except Exception:  # noqa: BLE001
        logger.exception("[review_mode] delete_overrides failed")


# ── Unmapped accounts surfacing ──────────────────────────────────────

def collect_unmapped_accounts(
    pack: CountryAccountingPack,
    accounts: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Given a parsed-account list (in the pack's parse_trial_balance
    output shape), return only the ones the pack's chart of accounts
    didn't recognise. Surfaced in Review Mode so the user can assign
    each one a canonical bucket manually.

    The returned dicts carry `code`, `name`, `amount` and a
    `suggested_bucket` field. The suggestion is None for now (no
    LLM-assisted suggestion in F3.4 — that's an F3.5 enhancement).
    """
    unmapped: List[Dict[str, Any]] = []
    for raw in accounts or []:
        code = str(raw.get("code") or raw.get("account_code") or "").strip()
        if not code:
            continue
        if pack.bucket_for(code) is None:
            unmapped.append({
                "code": code,
                "name": raw.get("name") or raw.get("account_name") or "",
                "amount": float(raw.get("amount") or raw.get("balance") or 0),
                "suggested_bucket": None,
            })
    return unmapped
