# Romania Launch Readiness — Tier-1 Validation Report

**Status: GREEN — defensible to ship the public claim *"Currently fully supported: Romania (OMFP 1802)"*.**

EEI Imobiliara's real Dec 2025 trial balance is now the authoritative test contract. Pipeline output matches all 8 validator checks (`scripts/run_tier1_validation.py --fixture ro_eei_dec_2025 --strict` → exit 0).

---

## What changed in the pipeline

| Layer | Change | Why |
|---|---|---|
| [`src/engine/api/_ro_coa.py:131`](src/engine/api/_ro_coa.py) | Account **722** (Producția imobilizări corporale) routed to new `capitalizedOwnWork` memo bucket instead of `otherIncome`. Same for 721 / 725. | Previously folded into EBITDA via `operating_profit += otherIncome`, inflating EEI's reported EBITDA by **RON 2.16M** and producing a fictitious positive equity valuation of RON 6.56M. |
| [`src/engine/api/_ro_coa.py:_empty_pl()`](src/engine/api/_ro_coa.py) | New `capitalizedOwnWork` field added to the IncomeStatement skeleton + `_BUCKET_TO_PL_FIELD` map. | Memo line surfaced on statements blob without contaminating EBITDA. |
| [`src/engine/api/pipeline.py:stage_validate`](src/engine/api/pipeline.py) | 4 new country-trap alerts: `capitalized_own_work`, `third_party_services_high` (628 > 30% of revenue), `revaluation_reserve` (105 > 25% of equity), `related_party_receivable` (461 > 5% of assets). | Distinguishes a CFO tool from a number-printer. EEI fixture's must_flag set required these. |

## Live verification (period 2ca84010-…)

```
Revenue KPI       RON 2.73M                                    ✓ operational only (706, not 706+722)
EBITDA KPI        RON -37K, -1.3% margin                       ✓ operational (was inflated 2.13M)
Total Debt        RON 14.08M                                   ✓
Valuation         -12.92M RON, Low confidence                  ✓ honest — was fictitiously +6.56M
Briefing          "revenue of 2,727,104 RON but slipped into   ✓ leads with the correct number
                   an EBITDA loss of -36,676 RON … D/E 2.42×"
Alerts            4 country-trap alerts firing                 ✓ 722, 628 anomaly, 105 reserve, 461 RP
```

## CI guard

[`.github/workflows/tier1-validation.yml`](.github/workflows/tier1-validation.yml) runs on every PR touching `src/engine/` or the fixture directory. The `romania-eei` job:
1. Boots the engine on `:8000` with venv Python.
2. Calls `python scripts/run_tier1_validation.py --fixture ro_eei_dec_2025 --period-id $CI_RO_EEI_PERIOD_ID --strict`.
3. Fails the build on any check regression. The `tier1-aggregate` gate blocks merge.

GitHub secrets required (set in repo Settings → Secrets and variables → Actions):

```
SUPABASE_URL                  https://<project>.supabase.co        (QA project, not prod)
SUPABASE_ANON_KEY             eyJ…
SUPABASE_SERVICE_ROLE_KEY     eyJ…
ANTHROPIC_API_KEY             sk-ant-…
MISTRAL_API_KEY               (optional)
```

Plus one repo Variable:
```
CI_RO_EEI_PERIOD_ID           2ca84010-e46f-4796-ad09-8b8d7460d03d
```

The other 4 Tier-1 jobs are stubs (`if: ${{ false }}`) — they flip on as each fixture's expected_*.json files land (Phase B).

## Operational handoff — restart the production backend

The fix lives on disk but **the running backend on `:8000` (PID `40255`) still has stale code** because it was started before the changes. The frontend is currently pointing at the diag venv backend on `:8002` via `scandi-desk-main/.env.local`. To make `:8000` the source of truth and remove the shim:

```bash
# 1. Stop the stale backend
kill 40255

# 2. Stop the diag backend (no longer needed once :8000 is fresh)
lsof -i :8002 -t | xargs kill 2>/dev/null

# 3. Restart :8000 under the venv interpreter (which has anthropic SDK + new code)
cd "/Users/alex/Desktop/folder claude Scandia copy"
set -a; source .env; set +a
./.venv/bin/python -m engine serve \
  --config config.yaml \
  --canonical-excel "files/Trading_analysis_YTDOct'25_LV.xlsx" \
  --host 127.0.0.1 --port 8000

# 4. Remove the dev shim so the frontend goes back to :8000
rm scandi-desk-main/.env.local

# 5. Re-validate end-to-end
./.venv/bin/python scripts/run_tier1_validation.py \
  --fixture ro_eei_dec_2025 \
  --period-id 2ca84010-e46f-4796-ad09-8b8d7460d03d \
  --strict
# Expect: exit 0, "Tier-1 launch gate: PASS (1/1 fixtures green)"
```

I have not killed `40255` autonomously — that interrupts your running session. Run the four commands above whenever you're ready.

## What's NOT in scope for Romania launch

- **The other 4 fixtures (FR/DE-SKR03/DE-SKR04/ES)** — source markdowns exist in `e2e/fixtures/ground-truth/`, expected_*.json files don't yet. Marketing claim narrows to Romania until those are green (Phase B).
- **Industry reclassification for EEI's org** — currently `industry_key='other'` which falls back to the generic 5-9-16× multiple band. Resetting to `real_estate_commercial` (Damodaran EU REIT 2026 band 12-16-22×) gives a tighter peer band and the confidence flag may flip to `medium`. User action via Settings → Industry; not a launch blocker.
- **Cosmetic Total-Debt KPI ratio** — spawned as a separate task (see chip).

## Marketing copy this PR makes defensible

> *"CFO AI auto-detects your trial balance's chart of accounts, language, and currency. Currently fully supported: **Romania (OMFP 1802)**. Validated end-to-end on real customer data — see our test suite. More countries rolling out monthly."*

Avoid claiming France/Germany/Spain in the public copy until their fixtures pass the same 8 checks.

---

**Files of record:**
- [`scripts/compare_to_fixture.py`](scripts/compare_to_fixture.py) — the 8-check validator
- [`scripts/run_tier1_validation.py`](scripts/run_tier1_validation.py) — orchestrator
- [`scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/`](scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/) — 6 expected_*.json + source_text.txt (from real PDF)
- [`.github/workflows/tier1-validation.yml`](.github/workflows/tier1-validation.yml) — CI guard
- [`out/tier1_report.json`](out/tier1_report.json) — latest run report (after every CI run)
