# Validation Fixture — YTD October 2025

This file is the **golden dataset** for `validate.py`. The engine must produce these exact classifications when run against `Trading_analysis_YTDOct_25_LV.xlsx` with the calibrated `config.yaml`.

If the engine output differs from this fixture, **DO NOT change the fixture to make the test pass**. Investigate the engine logic.

## Source data summary
- File: `Trading_analysis_YTDOct_25_LV.xlsx`
- Sheet: `Analysis` (categories) + `YTD Oct'25` (SKUs)
- Period: YTD October 2025 (10 months)
- Scope: `fara Annabella brand` (excluded)
- Total: 23 leaf categories, ~406 unique SKUs, 9,604 transaction rows

## Expected category-level classifications

| Category           | Vol_t  | NIV_kRON | GM%   | DIO | Real_margin% | Abs_profit_kRON | Expected_flag    |
|--------------------|--------|----------|-------|-----|--------------|-----------------|------------------|
| Ton                | 306.9  | 10118.2  | 14.2  | 90  | 12.4         | 624.6           | ANCHOR           |
| LEGUME CONSERVATE  | 1383.9 | 12915.9  | 6.3   | 60  | 5.0          | 408.2           | ANCHOR           |
| Macrou file        | 140.5  | 4767.1   | 10.8  | 50  | 9.6          | 291.9           | ANCHOR           |
| Macrou             | 352.8  | 7455.4   | 5.2   | 90  | 3.3          | 201.5           | ANCHOR_ALERT     |
| Sardina            | 158.6  | 3862.4   | 9.0   | 50  | 7.9          | 114.9           | ANCHOR           |
| JELEURI            | 8.7    | 380.4    | 21.8  | 180 | 18.4         | 70.0            | WARNING          |
| Somon              | 10.4   | 585.6    | 16.3  | 100 | 14.3         | 50.7            | KEEP             |
| COMPOT             | 79.5   | 728.7    | 9.4   | 180 | 6.1          | 44.1            | WARNING          |
| Sardine file       | 10.5   | 366.5    | 12.2  | 50  | 11.1         | 40.7            | KEEP             |
| ULEI               | 9.0    | 414.2    | 10.1  | 90  | 8.2          | 32.5            | KEEP             |
| SUC                | 205.2  | 881.7    | 10.1  | 30  | 9.3          | 21.5            | SCALE            |
| PET FOOD           | 152.3  | 969.3    | 2.8   | 50  | 1.6          | 15.9            | WARNING          |
| Sprot              | 10.2   | 224.5    | 8.0   | 80  | 6.4          | 14.4            | KEEP             |
| Ton file           | 5.5    | 476.4    | 27.3  | 90  | 25.5         | 10.9            | KEEP             |
| Caras              | 4.8    | 184.7    | 5.0   | 100 | 3.0          | 9.8             | KEEP             |
| SIROP              | 6.7    | 80.7     | 13.0  | 80  | 11.4         | 9.2             | KEEP             |
| Hering             | 3.1    | 71.3     | 13.9  | 90  | 12.1         | 8.6             | KEEP             |
| Hering file        | 19.8   | 538.0    | 4.9   | 90  | 3.1          | 7.9             | KEEP             |
| MURATURI           | 185.4  | 1401.0   | 1.1   | 40  | 0.1          | 1.7             | WARNING          |
| Pastrav            | 0.7    | 28.2     | 8.7   | 100 | 6.8          | 1.9             | ELIMINATE        |
| Plachie            | 0.4    | 6.0      | 13.7  | 100 | 11.7         | 0.7             | ELIMINATE        |
| SOSURI             | 8.6    | 297.9    | 28.4  | 40  | 27.5         | 0.0             | KEEP             |
| Calamar            | 0.2    | 3.4      | -90.7 | 100 | -92.7        | -3.2            | ELIMINATE        |

## Expected aggregate counts

```yaml
total_categories: 23
flag_distribution:
  ANCHOR: 4         # Ton, LEGUME CONSERVATE, Macrou file, Sardina
  ANCHOR_ALERT: 1   # Macrou
  SCALE: 1          # SUC
  KEEP: 10
  WARNING: 4        # JELEURI, COMPOT, MURATURI, PET FOOD
  ELIMINATE: 3      # Calamar, Pastrav, Plachie

capital_efficiency:
  total_woca_kron: 11206.7
  total_abs_profit_kron: 1978.5
  total_roic_pct: 17.7
  cost_of_capital_pct: 6.5
  net_value_creation_pct: 11.2  # ROIC - cost_of_capital

anchor_concentration:
  anchor_woca_share_pct: 82.5    # Top 5 anchors hold 82.5% of capital
  anchor_profit_share_pct: 82.9  # And produce 82.9% of profit
```

## Test assertion examples (pytest pseudocode)

```python
def test_anchor_alert_macrou():
    """Macrou: 353t (qualifies as anchor by volume) but real_margin 3.3% (below 5% floor)"""
    result = engine.run(VALIDATION_FIXTURE)
    macrou = next(r for r in result['anchor_alerts'] if r['id'] == 'Macrou')
    assert macrou['alert_reason'] == 'high_volume_anchor_below_floor'
    assert macrou['do_not_eliminate'] is True

def test_muraturi_warning_not_strategic():
    """MURATURI: 185t volume but real_margin 0.1% — must be warning, NOT auto-anchored"""
    result = engine.run(VALIDATION_FIXTURE)
    muraturi = next(r for r in result['warning'] if r['id'] == 'MURATURI')
    assert muraturi['reason'] == 'thin_real_margin'
    assert 'renegotiate' in muraturi['recommendation']

def test_calamar_eliminate():
    """Calamar: real_margin -92.7% — clear eliminate"""
    result = engine.run(VALIDATION_FIXTURE)
    calamar = next(r for r in result['eliminate'] if r['id'] == 'Calamar')
    assert calamar['reason'] == 'real_margin_negative'

def test_total_classification_counts():
    result = engine.run(VALIDATION_FIXTURE)
    assert len(result['anchor']) == 4
    assert len(result['anchor_alerts']) == 1
    assert len(result['scale']) == 1
    assert len(result['keep']) == 10
    assert len(result['warning']) == 4
    assert len(result['eliminate']) == 3
```

## Notes on edge cases

- **MURATURI** is the most important test case. It tests that high-volume alone does NOT trigger anchor protection. Real margin matters. Alex explicitly decided NOT to flag it as strategic. If the engine classifies MURATURI as ANCHOR, the test fails.

- **Macrou** tests the high-volume anchor floor. Volume qualifies it as anchor (353t), but real margin (3.3%) is below the 5% floor for high-volume anchors → ANCHOR_ALERT, never auto-eliminated.

- **JELEURI** has 21.8% gross margin and 18.4% real margin (very profitable!) but DIO of 180 days makes it WARNING. This tests that DIO > 100 days alone triggers warning even for highly profitable items. The recommendation should be "review inventory turnover", NOT "eliminate".

- **Calamar** is the only category with negative real margin in the dataset. Tests the absolute elimination rule.

- **SOSURI** has 27.5% real margin (very high) but only 8.6t volume and 0.0 absolute profit (margin × small base = tiny number). Tests that KEEP is the right default — high-margin small-volume items aren't candidates for either elimination or scaling.
