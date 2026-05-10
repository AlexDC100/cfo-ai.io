# SKU Decision Engine — Scandia Trading Division

## Project Mission

Build a **daily decision engine** that identifies SKUs to eliminate, monitor, or scale based on **real margin** (after cost of capital), **inventory rotation**, and **absolute profit contribution**. The system replaces gut-feel SKU rationalization with a deterministic, rules-based engine that protects working capital and increases ROIC.

**This is not a reporting tool. It is a decision system.** Output must be actionable: specific SKUs, specific actions, specific cash impact in RON.

The engine has been calibrated against the YTD October 2025 trading dataset (Excel: `Trading_analysis_YTDOct_25_LV.xlsx`), 23 leaf categories, ~406 SKUs.

---

## Core Business Logic (non-negotiable)

### The fundamental insight

We are not optimizing accounting profit. We are optimizing **working capital velocity** and **return on capital employed**. A SKU with 1% margin and 30-day DIO can be more valuable than a SKU with 15% margin and 180-day DIO.

The existing analysis already computes "GM% after WOCA" (Working Capital Cost) which is conceptually identical to our `real_margin`. The engine extends this from category-level to SKU-level decisions, applies anchor protection, and produces actionable lists.

### Formulas — implement exactly as specified

**1. Real margin (margin after cost of capital)**

```
real_margin_pct = gross_margin_pct - (DIO / 365) * cost_of_capital_pct
```

- `cost_of_capital_pct` = **6.5%** (confirmed with treasury, RO 2026)
- `DIO` source priority: (1) SKU-level from ERP if available, (2) category-level inheritance, (3) flag as `dio_status = "insufficient_data"` and exclude from elimination

**2. Absolute profit (volume-adjusted)**

```
absolute_profit_RON = real_margin_pct * sales_value_RON
```

This is the primary ranking metric. NOT margin %.

**3. GMROII (Gross Margin Return on Inventory Investment)**

```
GMROII = (gross_margin_RON * inventory_turns_per_year) / avg_inventory_value
```

**4. Composite score**

```
score = (real_margin_pct * sales_value_RON) / max(DIO, 1)
```

**5. Cash Conversion Cycle (category level)**

```
CCC = DIO + DSO - DPO
```

---

## Hybrid Granularity Model (CRITICAL — read carefully)

The Scandia data has DIO/CCC/WOCA at **category level** but P&L (margin breakdown, volumes, sales) at **SKU level**. The engine must handle this asymmetry explicitly.

### Inheritance rules

- If SKU has its own DIO from ERP → use it (`dio_source = "sku"`)
- If not → inherit from category (`dio_source = "category_inherited"`)
- All SKUs in same category share DIO until ERP integration delivers SKU-level inventory

### What changes per granularity

| Metric | Source level | Notes |
|--------|--------------|-------|
| Volume (tons), Sales (RON), GM%, Direct Margin | SKU | From `YTD Oct'25` sheet |
| DIO, DSO, DPO, CCC, WOCA | Category | From `Analysis` sheet, inherited to SKUs in category |
| Real margin | Computed per SKU | Uses SKU's GM% + category's DIO |
| Anchor classification | Per SKU AND per category | Both levels protected |

### Why this matters

A category-level anchor (e.g. PESTE-Macrou, 353t total) doesn't mean every SKU within it is an anchor. The engine ranks SKUs **within their category** and applies anchor protection at SKU level, while still reporting category-level metrics for context.

---

## Decision Rules — apply in this exact order

### STEP 1: Anchor classification (MUST run first)

A SKU is `anchor` if **any** of:
- Top 20% by `absolute_profit_RON` within its category
- `monthly_volume_tons > volume_threshold` AND `real_margin_pct > 0`
- Contributes > 5% of total division revenue
- `strategic_flag = TRUE` in master override

A category is `anchor` if **any** of:
- Contributes > 5% of total absolute profit (calibrated: top 5 categories = 82.5% of capital)
- Volume > 100 tons AND `real_margin_pct > 0`
- `strategic_flag = TRUE`

Anchors are **never eliminated automatically**. They follow ANCHOR_REVIEW or ANCHOR_ALERT rules.

### STEP 2: Apply rules

#### 🚨 ANCHOR_ALERT (anchors with margin/volume floor breach)

Generate `anchor_alert` if any of:
- `real_margin_pct < 5%` for anchors AND volume > 50t (floor for high-volume anchors — calibrated against MACROU case: 353t but real margin only 3.3%)
- `real_margin_pct < -2%` for any anchor (absolute floor — losing real money)
- DIO increased > 30% vs 3-month baseline
- Volume YoY decreased > 25%

Recommendation language must be "review urgently" / "renegotiate" / "monitor", **never "eliminate"**.

#### ⚠️ ANCHOR_REVIEW (anchors with watch flags but no breach)

- DIO > 90 days but real margin still acceptable
- 3-month negative trend without breach yet

#### 🔴 ELIMINATE (non-anchors only)

Flag for elimination if any of:
- `real_margin_pct < 0`
- `volume_tons < 5` AND `absolute_profit_kron < 5` (micro-volume + micro-profit, calibrated against Calamar/Pastrav/Plachie)
- `DIO > 150` AND `real_margin_pct < 5`
- Zero sales last 60 days AND stock_value > 0 (dead stock)
- Category CCC > 120 AND SKU is in bottom-quartile contributor

#### 🟡 WARNING (non-anchors only)

Flag for review if:
- `real_margin_pct` between 0% and 3% (calibrated against MURATURI: 0.1% real margin despite 185t volume)
- `DIO > 100` (calibrated against COMPOT/JELEURI at 180 days)
- 3-month negative trend (sales declining + DIO rising)

#### 🟢 SCALE (non-anchors only)

Flag for scaling if:
- `real_margin_pct > 10%` AND `volume_tons > 30`
- `real_margin_pct > 5%` AND `volume_tons > 100` (calibrated against SUC: 205t, 9.3% real margin, ROIC 19.8%)
- `GMROII > 150%`
- High volume + `DIO < 45`

#### ⚪ KEEP (default if no other flag fires)

Stable performers that don't need attention.

---

## Calibrated Thresholds (from YTD Oct 2025 data)

These were validated against actual Scandia data. Do not change without re-running calibration.

```yaml
cost_of_capital_pct: 6.5

anchor:
  top_pct_by_absolute_profit: 20
  min_revenue_share_pct: 5.0
  volume_threshold_tons_default: 50
  floor_real_margin_pct: -2.0
  high_volume_anchor_floor_pct: 5.0   # Macrou case: 353t but only 3.3% real margin → alert

eliminate:
  micro_volume_tons: 5
  micro_profit_kron: 5
  dio_capital_trap: 150
  capital_trap_real_margin: 5.0
  zero_sales_window_days: 60
  ccc_category_red_days: 120

warning:
  thin_real_margin_max_pct: 3.0
  long_dio_days: 100
  trend_lookback_months: 3

scale:
  high_margin_min_pct: 10.0
  high_margin_min_volume: 30
  volume_play_min_pct: 5.0
  volume_play_min_volume: 100
  gmroii_min_pct: 150
  high_volume_dio_max: 45
```

All thresholds **must be config-driven**. Zero magic numbers in business logic.

---

## Validation Dataset & Expected Outputs

The engine must reproduce these classifications when run on `Trading_analysis_YTDOct_25_LV.xlsx` (sheet `Analysis`, 23 leaf categories):

### Expected ANCHOR (5)
- Ton, LEGUME CONSERVATE, Macrou file, Sardina → ANCHOR (clean)
- **Macrou** → ANCHOR_ALERT (real_margin_pct < 5% threshold for high-volume anchors)

### Expected SCALE (1)
- SUC

### Expected WARNING (4)
- JELEURI, COMPOT (long DIO)
- **MURATURI** (thin real margin — Alex decided B: warning permanent until renegotiation, NO strategic_flag)
- PET FOOD (thin real margin)

### Expected ELIMINATE (3)
- Calamar (real_margin_negative)
- Pastrav, Plachie (micro-volume + micro-profit)

### Expected KEEP (10)
- Somon, Sardine file, ULEI, Sprot, Ton file, Caras, SIROP, Hering, Hering file, SOSURI

If the engine produces different classifications, debug **before** moving forward. The calibration is the contract.

---

## Master Override Table (`master_skus.csv`)

For SKUs/categories where business logic overrides automatic rules:

```csv
sku_id,category,strategic_flag,protected_until,override_reason
# (none currently — Alex decided NOT to flag MURATURI as strategic)
```

When the business decides MURATURI should be protected as strategic (after renegotiation analysis), add it here. Until then, it remains in WARNING.

---

## Data Schema

### `sales_daily` (from ERP, eventually; from `YTD Oct'25` sheet for Phase 1)
| column | type | notes |
|--------|------|-------|
| date | date | aggregate to month for now |
| sku_id | string | derived: brand + product_name + pack_size |
| sku_name | string | Denumire_Produs |
| brand | string | |
| pack_size | int | grams |
| category | string | Categ_Pr |
| business_unit | string | BU (DIVERSE / PESTE) |
| client | string | |
| client_parent | string | CLIENT_PARINTE |
| channel | string | Canal (KA/DIST) |
| volume_tons | decimal | |
| niv_kron | decimal | Net Invoiced Value |
| direct_margin_kron | decimal | |
| direct_margin_pct | decimal | |
| gm2_kron | decimal | full gross margin |
| gm2_pct | decimal | |

### `category_metrics` (from `Analysis` sheet)
| column | type | notes |
|--------|------|-------|
| category | string | PK |
| business_unit | string | DIVERSE / PESTE |
| volume_tons_total | decimal | |
| niv_kron_total | decimal | |
| gm_kron_total | decimal | |
| gm_pct_total | decimal | |
| dio_days | int | |
| dso_days | int | |
| dpo_days | int | |
| ccc_days | int | |
| woca_kron | decimal | working capital total |
| gm_after_woca_kron | decimal | absolute profit after capital cost |
| gm_pct_after_woca | decimal | real margin |

### `master_skus`
| column | type | notes |
|--------|------|-------|
| sku_id | string | PK |
| strategic_flag | bool | manual override |
| protected_until | date | optional expiry |
| override_reason | text | required if strategic_flag = TRUE |

### `config` — single YAML file, validated by pydantic

---

## Architecture

```
ERP (sales, costs)  ─┐
Inventory live       ─┼──→  n8n (daily orchestration, 06:00 RO time)
Treasury (Euribor)   ─┘            │
                                   ▼
                          PostgreSQL warehouse
                                   │
                                   ▼
                       Decision engine (Python)
                       • compute_metrics.py
                       • classify_anchors.py
                       • apply_rules.py
                       • generate_actions.py
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
            Power BI        Email/Slack          ERP write-back
           (dashboard)       (alerts)         (block re-order flag)
```

### Stack
- **Python 3.11** — pandas, polars (later for >1M rows), pydantic, sqlalchemy
- **PostgreSQL** — warehouse + computed metrics
- **n8n** — orchestration (existing Scandia stack)
- **Power BI** — dashboard layer (existing Scandia stack)
- **Claude API** — only for natural-language briefing (RO/EN), NOT for decision-making

---

## Deliverables

### Phase 1: Core engine (start here)

1. Project scaffolding — `pyproject.toml`, `src/` layout, `tests/`, `.env.example`
2. Config loader — pydantic model, loads `config.yaml` + env overrides
3. Excel loader — reads both `Analysis` (categories) and `YTD Oct'25` (SKUs) sheets, joins them
4. Metrics module (`src/engine/metrics.py`) — formulas above with unit tests
5. Anchor classifier (`src/engine/anchors.py`) — top-20% + volume + revenue logic, both SKU and category level
6. Rules engine (`src/engine/rules.py`) — applies decision rules in correct order
7. Action generator (`src/engine/actions.py`) — produces structured JSON output
8. **Validation runner** (`src/engine/validate.py`) — runs against the YTD Oct dataset and asserts the expected classifications above
9. CLI entrypoint — `python -m engine run --input path/to/data.xlsx --date 2026-05-04`

**Phase 1 is DONE only when `validate.py` passes against the YTD Oct dataset.**

### Phase 2: Integration
10. Postgres adapter
11. n8n trigger endpoint (FastAPI service, `/run-daily`)
12. Briefing generator (Claude API for RO/EN summary from JSON)
13. Power BI dataset export

### Phase 3: Intelligence layer (later)
14. Seasonality detection
15. Supplier lead-time learning
16. Reorder point recommendations

**Do not start Phase 2 or 3 until Phase 1 validation passes.**

---

## Output Contract

Every daily run produces `daily_decisions_YYYY-MM-DD.json`:

```json
{
  "run_date": "2026-05-04",
  "data_period": "YTD October 2025",
  "config_used": { "cost_of_capital_pct": 6.5 },
  "summary": {
    "total_categories_analyzed": 23,
    "total_skus_analyzed": 406,
    "capital_blocked_RON": 11206700,
    "capital_recoverable_30d_RON": 17800,
    "anchors_count": 5,
    "anchors_with_alerts": 1,
    "eliminate_count": 3,
    "warning_count": 4,
    "scale_count": 1,
    "keep_count": 10,
    "total_roic_pct": 17.7,
    "cost_of_capital_pct": 6.5
  },
  "anchor_alerts": [
    {
      "level": "category",
      "id": "Macrou",
      "real_margin_pct": 3.3,
      "volume_tons": 352.8,
      "alert_reason": "high_volume_anchor_below_floor",
      "recommendation": "review_pricing_or_sourcing",
      "do_not_eliminate": true,
      "context": "352.8t volume, 5.2% gross margin compressed to 3.3% by 90-day DIO"
    }
  ],
  "eliminate": [
    {
      "level": "category",
      "id": "Calamar",
      "real_margin_pct": -92.7,
      "volume_tons": 0.2,
      "absolute_profit_kron": -3.2,
      "reason": "real_margin_negative",
      "recommendation": "discontinue",
      "capital_freed_kron": 1.1
    }
  ],
  "warning": [
    {
      "level": "category",
      "id": "MURATURI",
      "real_margin_pct": 0.1,
      "volume_tons": 185.4,
      "absolute_profit_kron": 1.7,
      "reason": "thin_real_margin",
      "recommendation": "renegotiate_supplier_or_price_adjustment",
      "context": "185t volume but only 1.7 kRON profit YTD — high volume does NOT justify near-zero margin"
    }
  ],
  "scale": [],
  "keep": []
}
```

---

## Coding Standards

- **Type hints everywhere.** mypy strict mode.
- **No business logic in SQL.** SQL fetches data, Python decides.
- **Every formula has a unit test** with known inputs and expected outputs.
- **Every threshold reads from config.** Zero magic numbers.
- **Logging:** structured JSON, INFO for run lifecycle, DEBUG for per-SKU decisions.
- **Idempotency:** same inputs + same date = same output. No randomness, no clock dependency except `run_date` parameter.
- **Dry-run mode:** `--dry-run` flag produces output without ERP write-back.

---

## What NOT to do

- ❌ Do not build a generic "inventory dashboard". This is a decision engine.
- ❌ Do not let Claude API make decisions. Claude only writes the briefing.
- ❌ Do not hardcode thresholds. Everything in `config.yaml`.
- ❌ Do not eliminate anchor SKUs/categories automatically — ever.
- ❌ Do not skip unit tests on metrics module. The math is the product.
- ❌ Do not declare Phase 1 done without `validate.py` passing on the YTD Oct dataset.
- ❌ Do not infer DIO at SKU level when it's only available at category level — use inheritance and flag the source.
- ❌ Do not auto-flag MURATURI as strategic. Alex's decision: warning until renegotiation.
