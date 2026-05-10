"""Data loaders.

Two paths into the engine:
  1. Excel — `Trading_analysis_YTDOct_25_LV.xlsx` with `Analysis` and `YTD Oct'25` sheets.
  2. CSV fixture — flattened category data (used for validation when Excel isn't shipped).

Both produce the same `CategoryRow` list so downstream code is source-agnostic.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import List, Optional

from .models import CategoryRow, SkuRow


def load_categories_from_csv(path: Path) -> List[CategoryRow]:
    """Load fixture-format category CSV.

    Columns required: category, volume_tons, niv_kron, gm_pct, dio_days.
    Optional: business_unit, dso_days, dpo_days, ccc_days, woca_kron, abs_profit_kron.
    Any *_expected column is ignored here (those are validation targets, not inputs).
    """
    rows: List[CategoryRow] = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            rows.append(
                CategoryRow(
                    category=raw["category"].strip(),
                    business_unit=raw.get("business_unit") or None,
                    volume_tons=float(raw["volume_tons"]),
                    niv_kron=float(raw["niv_kron"]),
                    gm_pct=float(raw["gm_pct"]),
                    dio_days=int(float(raw["dio_days"])),
                    dso_days=_int_or_none(raw.get("dso_days")),
                    dpo_days=_int_or_none(raw.get("dpo_days")),
                    ccc_days=_int_or_none(raw.get("ccc_days")),
                    woca_kron=_float_or_none(raw.get("woca_kron")),
                    abs_profit_kron=_float_or_none(raw.get("abs_profit_kron")),
                    # The fixture's "_expected" real margin column carries the WOCA-corrected
                    # value from the Excel — treat it as the canonical stored margin.
                    real_margin_pct_stored=_float_or_none(
                        raw.get("real_margin_pct_stored")
                        or raw.get("real_margin_pct_expected")
                    ),
                )
            )
    return rows


# Section labels and roll-ups in the Analysis sheet that aren't leaf categories.
_NON_LEAF_LABELS = {"TOTAL", "DIVERSE", "PESTE", "10"}


def load_categories_from_excel(path: Path, sheet: str = "Analysis") -> List[CategoryRow]:
    """Load category metrics from the Analysis sheet.

    The sheet is a wide pivot table (97 columns) where each metric block is
    sliced by client (SELGROS, METRO, ...) with three sub-totals: IKA Total,
    DIST Total, GRAND TOTAL. We pull the GRAND TOTAL of each metric.

    Categories live in column 1; we filter out section labels (TOTAL, DIVERSE,
    PESTE) and the footer note. The remaining 23 are the leaf categories.

    Column layout (zero-indexed, fixed by the source template):
        1  category
        14 volume tons (GRAND TOTAL)
        28 NIV kRON   (GRAND TOTAL)
        58 GM%        (decimal — multiply ×100; GRAND TOTAL)
        60 DIO days
        61 DSO days
        62 DPO days
        63 CCC days
        82 GM after WOCA kRON (GRAND TOTAL)
        96 real margin% (decimal — multiply ×100; GRAND TOTAL)
    """
    import pandas as pd

    df = pd.read_excel(path, sheet_name=sheet, header=None)

    rows: List[CategoryRow] = []
    for i in range(df.shape[0]):
        cat_raw = df.iloc[i, 1]
        if not isinstance(cat_raw, str):
            continue
        cat = cat_raw.strip()
        if not cat or cat in _NON_LEAF_LABELS:
            continue
        if cat.startswith("GM*"):  # Footer note
            continue

        try:
            vol = float(df.iloc[i, 14])
            niv = float(df.iloc[i, 28])
            gm_pct = float(df.iloc[i, 58]) * 100.0  # decimal → percent
            dio = int(df.iloc[i, 60])
        except (ValueError, TypeError):
            continue  # Row missing required numeric data

        rows.append(
            CategoryRow(
                category=cat,
                business_unit=None,
                volume_tons=vol,
                niv_kron=niv,
                gm_pct=gm_pct,
                dio_days=dio,
                dso_days=_int_or_none(df.iloc[i, 61]),
                dpo_days=_int_or_none(df.iloc[i, 62]),
                ccc_days=_int_or_none(df.iloc[i, 63]),
                woca_kron=None,
                abs_profit_kron=_float_or_none(df.iloc[i, 82]),
                real_margin_pct_stored=_decimal_to_pct(df.iloc[i, 96]),
            )
        )
    return rows


def _decimal_to_pct(v: object) -> Optional[float]:
    """Excel stores percentages as decimals (0.0498 = 4.98%); convert to pct."""
    f = _float_or_none(v)
    return None if f is None else f * 100.0


def load_skus_from_excel(path: Path, sheet: str = "YTD Oct'25") -> List[SkuRow]:
    """Load SKU records from the YTD transaction sheet.

    The YTD sheet has ONE ROW PER TRANSACTION (channel × client × product), so
    a single SKU shows up many times. We aggregate by (brand, product_name,
    category) — summing volume / NIV / GM — to get one record per SKU.

    Volume/NIV are summed; GM% is the volume-weighted average (sum_GM / sum_NIV).
    """
    import pandas as pd

    df = pd.read_excel(path, sheet_name=sheet)
    df.columns = [str(c).strip() for c in df.columns]

    required = ["Denumire_Produs", "Categ_Pr", "Volume(to)", "NIV (kRon)", "GM (kRon)"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"YTD sheet missing required columns: {missing}")

    # Coerce numeric columns
    for col in ("Volume(to)", "NIV (kRon)", "GM (kRon)"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)

    # Aggregate: one row per (brand, product, category)
    df["Brand"] = df.get("Brand", "").fillna("")
    grouped = (
        df.groupby(["Brand", "Denumire_Produs", "Categ_Pr"], as_index=False)
        .agg(
            volume_tons=("Volume(to)", "sum"),
            niv_kron=("NIV (kRon)", "sum"),
            gm_kron=("GM (kRon)", "sum"),
            business_unit=("BU", "first") if "BU" in df.columns else ("Brand", "first"),
        )
    )

    skus: List[SkuRow] = []
    for _, r in grouped.iterrows():
        name = str(r["Denumire_Produs"]).strip()
        cat = str(r["Categ_Pr"]).strip()
        if not name or not cat or cat.lower() == "nan":
            continue
        brand = str(r["Brand"]).strip() or None
        niv = float(r["niv_kron"])
        gm_kron = float(r["gm_kron"])
        gm_pct = (gm_kron / niv * 100.0) if niv > 0 else 0.0
        sku_id = f"{brand}|{name}".strip("|") if brand else name
        skus.append(
            SkuRow(
                sku_id=sku_id,
                sku_name=name,
                brand=brand,
                category=cat,
                business_unit=str(r.get("business_unit") or "").strip() or None,
                volume_tons=float(r["volume_tons"]),
                niv_kron=niv,
                gm_kron=gm_kron,
                gm_pct=gm_pct,
            )
        )
    return skus


def _int_or_none(v: object) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        if isinstance(v, float) and v != v:  # NaN
            return None
    except TypeError:
        pass
    try:
        return int(float(v))  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return None


def _float_or_none(v: object) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return None
    if f != f:  # NaN
        return None
    return f


def _str_or_none(v: object) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return None
    return s
