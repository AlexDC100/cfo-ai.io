"""Pydantic-validated configuration loader.

All thresholds live in config.yaml; this module enforces the schema so a typo
in YAML fails loudly at startup rather than silently misclassifying SKUs.
"""

from __future__ import annotations

from pathlib import Path
from typing import List

import yaml
from pydantic import BaseModel, Field


class AnchorConfig(BaseModel):
    top_pct_by_absolute_profit: float = Field(gt=0, le=100)
    min_revenue_share_pct: float = Field(gt=0, le=100)
    volume_threshold_tons_default: float = Field(gt=0)
    floor_real_margin_pct: float
    high_volume_anchor_floor_pct: float


class EliminateConfig(BaseModel):
    micro_volume_tons: float = Field(gt=0)
    micro_profit_kron: float = Field(gt=0)
    dio_capital_trap: int = Field(gt=0)
    capital_trap_real_margin: float
    zero_sales_window_days: int = Field(gt=0)
    ccc_category_red_days: int = Field(gt=0)


class WarningConfig(BaseModel):
    thin_real_margin_max_pct: float
    long_dio_days: int = Field(gt=0)
    trend_lookback_months: int = Field(gt=0)
    # ── Volume + profit gates ─────────────────────────────────────────
    # Items with thin margin AND volume below this fall through to ELIMINATE
    # (too small to be worth a renegotiation effort). Default 5 t mirrors
    # eliminate.micro_volume_tons so behaviour is unchanged unless tweaked.
    min_volume_tons: float = Field(default=5.0, ge=0)
    # Items with thin margin AND volume above this escalate to a stronger
    # recommendation ("renegotiate urgently") because the working-capital
    # exposure is too large to leave on standard watch.
    max_volume_tons: float = Field(default=150.0, gt=0)
    # Absolute-profit floor — below this, treat as ELIMINATE regardless of
    # volume. 0 keeps current behaviour (all positive margins above 0 stay).
    min_profit_kron: float = Field(default=0.0)


class ScaleConfig(BaseModel):
    high_margin_min_pct: float
    high_margin_min_volume: float = Field(gt=0)
    volume_play_min_pct: float
    volume_play_min_volume: float = Field(gt=0)
    gmroii_min_pct: float
    high_volume_dio_max: int = Field(gt=0)


class WindowsConfig(BaseModel):
    dio_rolling_days: int = Field(gt=0)
    trend_lookback_days: int = Field(gt=0)
    yoy_lookback_days: int = Field(gt=0)


class OutputConfig(BaseModel):
    default_path: str
    json_filename_pattern: str
    briefing_languages: List[str]


class Config(BaseModel):
    cost_of_capital_pct: float = Field(gt=0, le=100)
    fx_eur_ron: float = Field(gt=0)
    anchor: AnchorConfig
    eliminate: EliminateConfig
    warning: WarningConfig
    scale: ScaleConfig
    windows: WindowsConfig
    output: OutputConfig


def load_config(path: Path) -> Config:
    """Load and validate config from YAML. Raises on malformed input."""
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    return Config.model_validate(raw)
