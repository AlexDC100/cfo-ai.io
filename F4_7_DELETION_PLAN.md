# F4.7 — Old-Surface Deletion Plan

> **Status:** PLAN ONLY. No code deleted.
> **Sunset target:** 2026-11-23 (F4.1 deploy date + 2 quarters per F3.15 §3e)
> **Authored:** 2026-05-24 (sprint end of F4.1–F4.6 batch)

## Context

Per F3.15 operator decision 3e (locked):

> "Set an explicit deprecation horizon: the old RAS-flavored canonical surface stays alive for a minimum of 2 quarters after the new Layer 2 reaches feature parity. ... Every deprecated field gets a runtime warning in the API response."

The canonical layer (`assembled_canonical_v1`) shipped on 2026-05-23 (F4.1f deploy). The 2-quarter horizon means the earliest deletion date is **2026-11-23**. The runtime warning channel shipped in F4.6 as the `deprecated_fields` array on `/api/period` responses (6 entries; module at `src/engine/api/deprecated_fields.py`).

This document is the **operational playbook** for the deletion ceremony.

## Pre-cutover checks (run on 2026-11-15, 8 days before sunset)

| Check | How | Pass criterion |
|---|---|---|
| FE no longer reads `assembled_bs/pl/cf` | grep `assembled_bs\|assembled_pl\|assembled_cf` in `scandi-desk-main/src/**/*.{ts,tsx}`. Expect only canonical reads. | 0 hits in FE code (excluding TypeScript type definitions slated for re-gen) |
| Briefing engine reads canonical | grep `assembled_bs\|assembled_pl\|assembled_cf` in `src/engine/briefing/`. Expect canonical equivalents. | 0 hits |
| External API consumers notified | Slack/email to anyone who's pulled the API in the last 90 days (audit access log). | Acknowledged or zero-traffic confirmed |
| Canonical envelope present on every recent period | SQL: `SELECT count(*) FROM financial_periods WHERE assembled_canonical_v1 IS NULL AND created_at > '2026-08-01'`. | 0 rows (post-F4.1f periods all populated) |
| F4.2-PARITY gate has been GREEN for ≥60 days | Check CI/manual gate log | Continuously GREEN |
| Detection envelope adoption | `SELECT count(*) FROM financial_periods WHERE detection_envelope IS NULL AND created_at > '2026-08-01'`. | 0 rows |

If ANY check fails, defer cutover to next quarter and document why.

## Deletion scope

### Engine code

**`src/engine/country_packs/ro_romania/chart_of_accounts.py`** (the bulk of the work)

| Block | Lines (approx) | Action |
|---|---|---|
| `ebitda_operational / ebitda_statutory / ebitda_operating_view / ebitda_adjusted` computations | ~1378-1391 | Delete computation block; downstream consumers read `assembled_canonical_v1.methodology.ebitda.{reported,strict,cash,adjusted}`. |
| `ebitda_cash / ebitda_statutory_with_711` | ~1383-1386 | Delete; same destination. |
| `core_ebitda / adjusted_ebitda` | ~1418-1432 | Delete. |
| `_BUCKET_TO_BS_FIELD / _BUCKET_TO_PL_FIELD` mapping tables | (search for them) | KEEP for now — the canonical_adapter currently routes off line_items.bucket, which still uses legacy bucket names. Removing the mapping tables is a separate F5+ chunk. |
| Persisted PL fields in the `result["statements"]["assembled_pl"]` dict | ~1456-1500 | Trim to ONLY keep fields not yet replaced (revenue, cogs, opex_total, depreciation, net_income — these are read by FE briefing in places not yet refactored). Schedule a follow-up F4.7b for the second wave. |

**`src/engine/api/pipeline.py`**

| Block | Action |
|---|---|
| `stage_compute()` ebitda_statutory_with_711 metric registration | Delete — replaced by methodology variant. |
| `_serialize_valuation` `assembled_*` reads | Switch to canonical aggregates. |

### Database

| Column | Action |
|---|---|
| `financial_periods.assembled_canonical_v1` (JSONB) | KEEP — this is the new surface. |
| `financial_periods.detection_envelope` (JSONB) | KEEP — new surface. |
| `financial_periods.methodology_version` (TEXT scalar) | KEEP — new surface. |
| `calculated_metrics` rows with `name IN ('ebitda', 'ebitda_statutory_with_711', 'ebitda_operational')` | Soft-delete via SQL: archive to `calculated_metrics_legacy` table, then DELETE. Allows rollback for one quarter. |
| `statement_line_items.bucket` column values like `propertyPlantEquipment`, `accountsReceivable` etc. | KEEP — these are the engine's persistence-layer names, not the deprecated API surface. |

### Frontend (separate chunk — F4.7b)

The FE has its own deprecation surface (TypeScript types that mirror legacy `assembled_bs` shapes). FE cutover happens after engine cutover, with its own 2Q horizon. Out of scope for F4.7.

### Methodology + tests

- `methodology/ro_ras_2025_v1.yaml` — KEEP and bump to `methodology_version: 1.1.0` to signal the engine-side cutover.
- `scripts/check_methodology_parity.py` — DELETE the gate (legacy fields gone → no parity to check).
- `BASELINE_HISTORY.md` — append "F4.7 cutover" entry documenting what was removed.

### Deprecated fields API surface (F4.6)

- After cutover, the `deprecated_fields` array becomes empty (no remaining items match the still-emitted fields).
- KEEP the array on responses (zero-cost) so future deprecations have an established channel.

## Cutover ceremony (deploy day, 2026-11-23)

1. **Pre-flight on the VPS** (1 hour before deploy window):
   - Take a Supabase DB snapshot (Dashboard → Backups → Manual snapshot).
   - Pull current `chart_of_accounts.py` and `pipeline.py` from `/opt/cfo-ai/src/...` to a local `pre_f4_7/` directory.
   - Verify F-A3.1 GREEN on production container (hard tripwire).

2. **Land the deletion PR**:
   - Local: apply the deletes from "Engine code" section above.
   - Re-run all 4 gates locally — they must stay GREEN (F-A3.1 + F3.1-PARITY are the strictest; expect F3.1-PARITY to RED on the assembled output diff, which is intentional — re-baseline EEI + Scandia with a `pre_f4_7.json` archive per BASELINE_HISTORY ceremony).
   - Add F4.7 entry to BASELINE_HISTORY.md.

3. **Deploy under §14**:
   - rsync host source (per F3.14 rsync discipline; one rsync per (source, dest) pair).
   - `docker compose build backend && docker compose up -d backend`.
   - Apply the SQL migration that archives + deletes the legacy `calculated_metrics` rows. Provide rollback SQL inline.
   - Run all 4 in-container gates. F-A3.1 must be GREEN within 30 seconds of restart, or auto-rollback (revert host source + rebuild).

4. **Verify in production** (15 minutes post-deploy):
   - Hit `/api/period/{recent_period_id}` and confirm response has `assembled_canonical_v1` populated, `assembled_bs/pl/cf` either absent or empty, `deprecated_fields` array shorter (or empty).
   - Pull `cfo-ai-backend` container logs for any new error class.
   - Open the dashboard for a known org+period; confirm the briefing renders.

5. **Post-cutover** (next-day check):
   - Repeat the verification — give the FE 24h to retry/cache.
   - If a regression surfaces, restore the engine code from `pre_f4_7/` AND restore the DB snapshot. Cutover deferred to next quarter.

## Rollback plan (if cutover fails)

1. SSH to VPS, restore the engine code:
   ```
   scp pre_f4_7/chart_of_accounts.py root@187.124.0.37:/opt/cfo-ai/src/engine/country_packs/ro_romania/chart_of_accounts.py
   scp pre_f4_7/pipeline.py root@187.124.0.37:/opt/cfo-ai/src/engine/api/pipeline.py
   ```
2. `docker compose build backend && docker compose up -d backend`.
3. Restore the DB snapshot from Supabase Dashboard.
4. Run gates. Confirm GREEN.
5. Document the failure in BASELINE_HISTORY.md; schedule a re-attempt with the regression addressed.

## Quarter-by-quarter horizon

- **Q3 2026 (Jul–Sep)**: F4.1 in production, deprecated_fields warning live. Monitor traffic.
- **Q4 2026 (Oct–Dec)**: Pre-cutover checks (Nov 15) → cutover (Nov 23). If clean, F4.7 closed.
- **Q1 2027**: Archive `calculated_metrics_legacy` table; delete one quarter after cutover (2027-02-23).

## Sign-off requirements

Before cutover proceeds:
- [ ] Operator authorization in chat (text + AskUserQuestion)
- [ ] All Pre-cutover checks GREEN
- [ ] DB snapshot confirmed in Supabase Dashboard
- [ ] Engine source archived to `pre_f4_7/`
- [ ] Rollback SQL ready
- [ ] 4 gates GREEN on production container

Without ALL six, defer to next quarter.
