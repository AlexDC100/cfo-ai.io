# F4.7 — Pre-Staged Cutover Diff

> **Status:** PRE-STAGED. Authored 2026-05-24. Earliest execution date: 2026-11-23.
> **Companion:** `F4_7_DELETION_PLAN.md` (the ceremony, rollback, sign-off requirements).

This document is the **mechanical execution sheet** for the F4.7 cutover. On 2026-11-23, an operator (or a Claude session with explicit authorization) follows the steps below verbatim. Line numbers are not used — every change is anchored by `grep`-friendly markers so the diff still applies even if the surrounding code has drifted in the intervening 6 months.

## Pre-execution sanity check (run on cutover day, before any edits)

```bash
cd /opt/cfo-ai && \
  python3 scripts/check_assembled_parity.py && \
  python3 scripts/measure_bs_drift.py && \
  python3 scripts/check_canonical_present.py && \
  python3 scripts/check_canonical_roundtrip.py && \
  python3 scripts/check_methodology_parity.py
```

All five must be GREEN. If any is RED, abort cutover and investigate (the engine has regressed independent of F4.7; fix that first).

## Edit 1 — Delete legacy EBITDA computations from chart_of_accounts.py

**Anchor:** the comment block starting with `## ── THREE EBITDA VIEWS`.

Find the block:
```bash
grep -n "THREE EBITDA VIEWS" /opt/cfo-ai/src/engine/country_packs/ro_romania/chart_of_accounts.py
```

Delete from that line through the line containing `ebitda_statutory_with_711 = ebitda_cash + capitalized + inventory_variation_memo` (inclusive of the comment block + the four assignments). Replace with:

```python
# F4.7 — legacy EBITDA computations removed. All EBITDA variants now
# come from the methodology layer (methodology/ro_ras_2025_v1.yaml)
# and are surfaced on assembled_canonical_v1.methodology.ebitda.
# See F4_7_DELETION_PLAN.md for cutover ceremony details.
```

## Edit 2 — Delete `core_ebitda` and `adjusted_ebitda` computations

**Anchors:**
```bash
grep -n "core_ebitda = ebitda_statutory" /opt/cfo-ai/src/engine/country_packs/ro_romania/chart_of_accounts.py
grep -n "adjusted_ebitda = operating_ebitda" /opt/cfo-ai/src/engine/country_packs/ro_romania/chart_of_accounts.py
```

Delete both assignment lines + their preceding comment block. Same replacement comment as Edit 1 (one location only).

## Edit 3 — Trim the assembled_pl dict to canonical-only fields

**Anchor:** the dict literal containing `"ebitda_operational":     round(ebitda_operational, 2),`.

```bash
grep -n '"ebitda_operational":' /opt/cfo-ai/src/engine/country_packs/ro_romania/chart_of_accounts.py
```

Delete these keys from the dict (KEEP everything else — `revenue`, `cogs`, `opex_total`, `depreciation`, `net_income` and the financial-result family stay; FE briefing still reads them at cutover time, see F4.7b for the FE wave):

- `ebitda`
- `ebitda_operational`
- `ebitda_statutory`
- `ebitda_operating_view`
- `ebitda_adjusted`
- `operating_ebitda`
- `operating_ebit`
- `ebitda_cash`
- `ebitda_statutory_with_711`
- `inventory_variation_memo`
- `core_ebitda`
- `adjusted_ebitda`

Their replacements live under `assembled_canonical_v1.methodology.ebitda` (`reported`, `strict`, `cash`, `adjusted`) and `assembled_canonical_v1.methodology.totals` (`gross_profit`, `operating_profit_reported`).

## Edit 4 — Delete `ebitda_statutory_with_711` metric from pipeline.py

```bash
grep -n 'ebitda_statutory_with_711' /opt/cfo-ai/src/engine/api/pipeline.py
```

Each hit → if it's inside `stage_compute`'s metrics list (a dict like `{"name": "ebitda_statutory_with_711", "value": ...}`), delete the dict literal entirely. If it's a comment, delete the comment.

## Edit 5 — Bump methodology version

```yaml
# methodology/ro_ras_2025_v1.yaml — DELETE
# methodology/ro_ras_2026_v1.yaml — CREATE (copy of 2025_v1 with version bumped)
```

Cleaner: bump the YAML's own `methodology_version: 1.0.0` → `1.1.0` in place. Add a `changelog:` block at the top documenting the post-cutover state:

```yaml
methodology_version: "1.1.0"
changelog:
  - version: "1.1.0"
    date: "2026-11-23"
    change: "Post-F4.7 cutover — legacy in-code EBITDA computations removed; this YAML is now the sole source of EBITDA + ratio recipes."
```

## SQL migration (apply via Supabase Dashboard SQL Editor)

```sql
-- F4.7 — archive + delete legacy EBITDA metric rows.
-- Reversible for 1 quarter via calculated_metrics_legacy archive table.

create table if not exists calculated_metrics_legacy as
  select * from calculated_metrics where 1 = 0;

insert into calculated_metrics_legacy
select * from calculated_metrics
where name in (
  'ebitda',
  'ebitda_operational',
  'ebitda_statutory_with_711',
  'core_ebitda',
  'adjusted_ebitda',
  'inventory_variation_memo'
);

delete from calculated_metrics
where name in (
  'ebitda',
  'ebitda_operational',
  'ebitda_statutory_with_711',
  'core_ebitda',
  'adjusted_ebitda',
  'inventory_variation_memo'
);

-- 90 days after cutover (2027-02-23), drop the archive:
-- drop table calculated_metrics_legacy;
```

## Re-baseline ceremony

After Edit 1-4 lands, F3.1-PARITY will RED on EEI + Scandia (the assembled output diff is intentional). Re-baseline:

```bash
cd /opt/cfo-ai
# Archive current baselines (pre-cutover state)
cp src/engine/country_packs/ro_romania/fixtures/regression_baselines/eei_dec_2025.json \
   src/engine/country_packs/ro_romania/fixtures/regression_baselines/archive/eei_dec_2025_pre_f4.7.json
cp src/engine/country_packs/ro_romania/fixtures/regression_baselines/scandia_fy2025.json \
   src/engine/country_packs/ro_romania/fixtures/regression_baselines/archive/scandia_fy2025_pre_f4.7.json
# Re-capture with the deleted fields gone
python3 scripts/capture_assembled_baseline.py --rebaseline
# Confirm parity GREEN on new baselines
python3 scripts/check_assembled_parity.py
```

Add a `BASELINE_HISTORY.md` entry documenting the F4.7 cutover (template at the top of the file).

## Test command after deploy

```bash
# Hit a known period; confirm legacy fields absent + canonical fields present.
curl -sS 'https://api.cfo-ai.finance/api/period/<UUID>' \
  -H "Authorization: Bearer $JWT" | \
  jq '.statements.assembled_pl | has("ebitda_statutory") as $legacy_present
      | .statements.assembled_canonical_v1.methodology.ebitda.reported as $canonical
      | "legacy_present=\($legacy_present), canonical_value=\($canonical)"'
```

Expected: `legacy_present=false, canonical_value=<number>`.

Plus run the full 5-gate suite in-container — F-A3.1 must stay GREEN within 30 seconds of restart (hard tripwire; auto-rollback if RED).

## Why this is pre-staged not executed

Per F3.15 operator decision 3e (locked):

> "Set an explicit deprecation horizon: the old RAS-flavored canonical surface stays alive for a **minimum of 2 quarters** after the new Layer 2 reaches feature parity."

F4.1 (canonical layer feature parity) shipped 2026-05-23. The 2-quarter minimum lands on 2026-11-23. Today is 2026-05-24 — running F4.7 now would violate the locked operator decision and put any FE/briefing consumer still reading legacy fields into a broken state with no warning runway.

The `deprecated_fields` warnings (F4.6) are the consumer's 6-month notice. Run F4.7 only after they've all migrated AND the pre-cutover checks in `F4_7_DELETION_PLAN.md` are GREEN.
